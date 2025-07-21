// strategies/MomentumRiderStrategy.js
// Version 8.0.0 - FINAL: Correctly uses limit orders for entry and simplifies exit logic.

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
        if (this.bot.isOrderInProgress) {
            this.logger.debug("Ignoring signal: Order already in progress.");
            return;
        }

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
            this.logger.info(`[${this.getName()}] POSITION SYNCED. Algorithmic trailing stop is now active.`);
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] POSITION CLEARED via WebSocket.`);
            this.position = null;
            this.isExitInProgress = false;
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
            
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0] || !this.bot.orderBook.asks?.[0]?.[0]) {
                throw new Error("Delta L1 order book is not ready.");
            }

            const limitPrice = side === 'buy' 
                ? parseFloat(this.bot.orderBook.asks[0][0])
                : parseFloat(this.bot.orderBook.bids[0][0]);

            const stopLossPrice = side === 'buy' 
                ? limitPrice - this.bot.config.stopLossOffset 
                : limitPrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0 || limitPrice <= 0) {
                throw new Error(`Invalid price calculated. Limit: ${limitPrice}, SL: ${stopLossPrice}`);
            }
            
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                bracket_stop_loss_price: stopLossPrice.toString()
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC limit order with fail-safe SL.`);
            this.lastEntrySignalPrice = currentPrice;
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order placed successfully.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`); 
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit: Placing a reduce_only market order.`);
        
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
            if (response.result) {
                this.logger.info(`[${this.getName()}] Algorithmic exit order placed successfully.`);
            } else {
                this.logger.warn(`[${this.getName()}] Exit order rejected. Position may have been closed by hard SL.`, {
                    response: JSON.stringify(response)
                });
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Error placing algorithmic exit order.`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;
