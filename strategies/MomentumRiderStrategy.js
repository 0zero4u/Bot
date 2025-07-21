// strategies/MomentumRiderStrategy.js
// Version 5.2.0 - FINAL: SL is now correctly calculated from Delta's L1 BBO, not the signal price.

const { v4: uuidv4 } = require('uuid');

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        this.lastEntrySignalPrice = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
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
                peakPrice: this.lastEntrySignalPrice
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
            this.logger.warn(`[${this.getName()}] ALGORITHMIC TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            // <<< THE DEFINITIVE FIX: Use Delta's L1 Order Book for SL calculation >>>
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0] || !this.bot.orderBook.asks?.[0]?.[0]) {
                throw new Error("Delta L1 order book is not ready. Cannot calculate a safe SL.");
            }

            // Use the BEST BID as the reference for a LONG trade's SL.
            // Use the BEST ASK as the reference for a SHORT trade's SL.
            const deltaReferencePrice = side === 'buy' 
                ? parseFloat(this.bot.orderBook.bids[0][0]) 
                : parseFloat(this.bot.orderBook.asks[0][0]);
            
            const stopLossPrice = side === 'buy' 
                ? deltaReferencePrice - this.bot.config.stopLossOffset 
                : deltaReferencePrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated from Delta BBO.`, { deltaReferencePrice, stopLossPrice });
                return;
            }
            
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                bracket_stop_loss_price: stopLossPrice.toString()
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC market order with fail-safe SL based on Delta BBO.`, {
                signalPrice: currentPrice,
                deltaBBO: deltaReferencePrice,
                stopLoss: stopLossPrice.toFixed(4)
            });
            this.lastEntrySignalPrice = currentPrice;
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order placed successfully. Exchange is managing the fail-safe SL.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                this.lastEntrySignalPrice = null;
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`); 
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
            this.lastEntrySignalPrice = null;
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Cancelling all open orders for ${this.bot.config.productSymbol} to remove the hard SL.`);
        try {
            await this.bot.client.cancelAllOrders(this.bot.config.productId);
            this.logger.info(`[${this.getName()}] Hard SL cancelled successfully.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] Could not cancel hard SL, but proceeding with exit order anyway. Manual check may be required.`, { message: error.message });
        }
        
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
            this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order. Manual intervention may be required.`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;
