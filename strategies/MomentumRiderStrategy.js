// strategies/MomentumRiderStrategy.js
// Version 5.0.0 - FINAL: Centralizes atomic order creation within the strategy.

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        this.lastEntrySignalPrice = null;

        // This strategy handles its own atomic stop-loss on entry.
        // It does not require the main bot to attach any orders after the fact.
        this.hasBracketOrders = false;
        this.hasFailSafeStop = false;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else if (!this.bot.isOrderInProgress) {
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

    manageOpenPosition(currentPrice) {
        if (!this.position || this.isExitInProgress || !this.position.peakPrice) return;

        let drawdown = 0;
        if (this.position.side === 'buy') {
            if (currentPrice > this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = this.position.peakPrice - currentPrice;
        } else { 
            if (currentPrice < this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = currentPrice - this.position.peakPrice;
        }

        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] ALGORITHMIC TRAILING STOP TRIGGERED! Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0]) {
                throw new Error("L1 order book is not ready for SL calculation.");
            }

            const deltaReferencePrice = side === 'buy' ? parseFloat(this.bot.orderBook.bids[0][0]) : parseFloat(this.bot.orderBook.asks[0][0]);
            const stopLossPrice = side === 'buy' ? deltaReferencePrice - this.bot.config.stopLossOffset : deltaReferencePrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                throw new Error(`Invalid Stop-Loss Price (<=0) calculated: ${stopLossPrice}`);
            }
            
            // --- THIS IS THE CORRECT, ATOMIC ORDER PAYLOAD ---
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                bracket_stop_loss_price: stopLossPrice.toString(),
                bracket_stop_trigger_method: 'last_traded_price'
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC market order with fail-safe SL.`, { payload: orderData });
            this.lastEntrySignalPrice = currentPrice;
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order accepted by exchange.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                throw new Error(JSON.stringify(response)); 
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
            this.lastEntrySignalPrice = null;
            if (error.message.includes('bracket_order_position_exists')) {
                this.logger.warn(`[${this.getName()}] State mismatch detected. Forcing state correction.`);
                this.bot.forceStateCorrection();
            }
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit. Cancelling fail-safe SL before placing market order.`);
        
        await this.bot.safeCancelAll(this.bot.config.productId);
        this.logger.info(`[${this.getName()}] Proceeding with market exit order.`);

        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
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
            this.logger.info(`[${this.getName()}] Algorithmic exit order placed.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order.`, { message: error.message });
            this.isExitInProgress = false; // Allow retry
        }
    }
}
module.exports = MomentumRiderStrategy;
