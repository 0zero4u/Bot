// strategies/MomentumRiderStrategy.js
// Version 6.0.0 - FINAL: Rearchitected to use WebSocket state and avoid failing REST calls.

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
            this.logger.info(`[${this.getName()}] POSITION SYNCED via WebSocket. Algorithmic trailing stop is now active.`, {
                entry: this.position.entryPrice,
                peak: this.position.peakPrice
            });
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] POSITION CLEARED via WebSocket.`);
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
            // <<< THE DEFINITIVE FIX: REMOVED the failing pre-emptive cancel call >>>
            // We now rely on the WebSocket position state to prevent new trades if already in a position.
            
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0] || !this.bot.orderBook.asks?.[0]?.[0]) {
                throw new Error("Delta L1 order book is not ready. Cannot calculate a safe SL.");
            }

            const deltaReferencePrice = side === 'buy' ? parseFloat(this.bot.orderBook.bids[0][0]) : parseFloat(this.bot.orderBook.asks[0][0]);
            const stopLossPrice = side === 'buy' ? deltaReferencePrice - this.bot.config.stopLossOffset : deltaReferencePrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated.`, { deltaReferencePrice, stopLossPrice });
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
                // If the error is 'option_exists', it means an old SL was orphaned. Manual cleanup needed.
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
        
        // <<< THE DEFINITIVE FIX: REMOVED the failing cancelAllOrders call. >>>
        // We simply place a reduce_only order. The exchange will handle the state.
        this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Placing a reduce_only market order.`);
        
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
                // This can happen if the hard SL was already triggered. This is not a critical error.
                this.logger.warn(`[${this.getName()}] Algorithmic exit order was rejected. The position may have already been closed by the hard SL.`, {
                    response: JSON.stringify(response)
                });
            } else {
                this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed successfully.`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: An unexpected error occurred while placing the algorithmic exit order.`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;
