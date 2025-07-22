// strategies/MomentumRiderStrategy.js
// Version 4.1.0 - Verified alignment with Delta Exchange API for atomic bracket orders.

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        this.lastEntrySignalPrice = null;

        // --- STRATEGY CONFIG ---
        // This strategy signals that it will create its own bracket orders.
        this.hasBracketOrders = true;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            // A position is open; manage the software-based trailing stop.
            this.manageOpenPosition(currentPrice);
        } else if (!this.bot.isOrderInProgress) {
            // No position is open, try to enter.
            await this.tryEnterPosition(currentPrice);
        }
    }

    onPositionUpdate(positionUpdate) {
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        if (positionIsOpen && !this.position) {
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell',
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize),
                peakPrice: this.lastEntrySignalPrice || parseFloat(positionUpdate.entry_price)
            };
            this.logger.info(`[${this.getName()}] POSITION SYNCED. Algorithmic trailing stop is now active.`, {
                entry: this.position.entryPrice,
                peak: this.position.peakPrice
            });
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            this.lastEntrySignalPrice = null;
        }
    }

    /**
     * Manages the software-based trailing stop to ride the trend.
     */
    manageOpenPosition(currentPrice) {
        if (!this.position || this.isExitInProgress || !this.position.peakPrice) return;

        let drawdown;
        if (this.position.side === 'buy') {
            if (currentPrice > this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = this.position.peakPrice - currentPrice;
        } else { // 'sell'
            if (currentPrice < this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = currentPrice - this.position.peakPrice;
        }

        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] ALGORITHMIC TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Exiting.`);
            this.exitPosition();
        }
    }

    /**
     * Creates and places a market order with an attached fail-safe stop-loss,
     * aligning with the 'bracket_stop_loss_price' API parameter.
     */
    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0]) {
                throw new Error("Delta L1 order book is not ready. Cannot calculate a safe SL.");
            }

            const deltaReferencePrice = side === 'buy' 
                ? parseFloat(this.bot.orderBook.bids[0][0]) 
                : parseFloat(this.bot.orderBook.asks[0][0]);
            
            const stopLossPrice = side === 'buy' 
                ? deltaReferencePrice - this.bot.config.stopLossOffset 
                : deltaReferencePrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated.`, { deltaReferencePrice, stopLossPrice });
                return;
            }
            
            // This order payload is constructed according to the Delta Exchange API docs.
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                // This is the correct parameter for an atomic market order + stop loss.
                bracket_stop_loss_price: stopLossPrice.toString(),
                // Explicitly set the trigger method for the bracket SL for clarity and safety.
                bracket_stop_trigger_method: 'last_traded_price'
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC market order with fail-safe SL.`, {
                payload: orderData
            });

            this.lastEntrySignalPrice = currentPrice;
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order placed successfully. The exchange is now managing the fail-safe SL.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                throw new Error(JSON.stringify(response)); 
            }
        } catch (error) {
            this.lastEntrySignalPrice = null;
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
            if (error.message.includes('bracket_order_position_exists')) {
                this.logger.warn(`[${this.getName()}] State mismatch detected: Exchange reports an open position. Forcing state correction.`);
                this.bot.forceStateCorrection();
            }
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    /**
     * Exits the position when the algorithmic trailing stop is triggered.
     * It first cancels the exchange-side fail-safe stop before exiting with a market order.
     */
    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Cancelling all open orders for ${this.bot.config.productSymbol} to remove the hard SL.`);
        
        try {
            // Use the high-level, safe helper to cancel the bracket SL.
            await this.bot.safeCancelAll(this.bot.config.productId);
            this.logger.info(`[${this.getName()}] Fail-safe order cancelled. Proceeding with market exit.`);

            const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.position.size, 
                side: exitSide, 
                order_type: 'market_order',
                reduce_only: true 
            };
            const response = await this.bot.placeOrder(orderData);
            if (!response.result) {
                throw new Error(`Exchange rejected algorithmic exit order: ${JSON.stringify(response)}`);
            }
            this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order. Manual intervention may be required.`, { message: error.message });
            this.isExitInProgress = false; // Allow retry on failure
        }
    }
}
module.exports = MomentumRiderStrategy;
