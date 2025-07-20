// strategies/MomentumRiderStrategy.js
class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null; // { entryPrice, side, peakProfitPrice }
    }

    getName() { return "MomentumRiderStrategy"; }

    // This strategy uses the main order update handler to manage its state
    onOrderUpdate(order) {
        // If an order fills and we don't have a position, it's our entry fill.
        if (order.state === 'filled' && !this.position) {
            this.position = {
                entryPrice: parseFloat(order.average_fill_price),
                side: order.side,
                peakProfitPrice: parseFloat(order.average_fill_price)
            };
            this.logger.info(`[${this.getName()}] POSITION OPENED:`, this.position);
        }
    }

    async onPriceUpdate(currentPrice) {
        // If there's no open position, we look for an entry
        if (!this.position) {
            await this.tryEnterPosition(currentPrice);
            return;
        }

        // If we have a position, we manage the smart exit
        this.manageOpenPosition(currentPrice);
    }
    
    async tryEnterPosition(currentPrice) {
        const priceDifference = Math.abs(currentPrice - this.bot.priceAtLastTrade);
        if (priceDifference < this.bot.config.priceThreshold) return;

        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            this.logger.info(`[${this.getName()}] ENTERING POSITION at market, side: ${side}`);
            const orderData = { product_id: this.bot.config.productId, size: this.bot.config.orderSize, side, order_type: 'market_order' };
            const response = await this.bot.placeOrder(orderData);
            
            if (response.success) {
                this.logger.info(`[${this.getName()}] Entry market order placed. Waiting for fill to confirm position.`);
                // We don't set this.position here. We wait for the 'onOrderUpdate' confirmation.
                this.bot.priceAtLastTrade = currentPrice;
            } else {
                throw new Error(JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place entry order:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    manageOpenPosition(currentPrice) {
        const { side, peakProfitPrice } = this.position;
        let shouldExit = false;

        if (side === 'buy') {
            if (currentPrice > peakProfitPrice) {
                this.position.peakProfitPrice = currentPrice; // New high-water mark
                this.logger.info(`[${this.getName()}] New peak profit price: ${currentPrice}`);
            } else {
                const drawdown = peakProfitPrice - currentPrice;
                if (drawdown >= this.bot.config.adverseMovementThreshold) {
                    this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT TRIGGERED! Drawdown ${drawdown} >= ${this.bot.config.adverseMovementThreshold}. Exiting position.`);
                    shouldExit = true;
                }
            }
        } else { // side === 'sell'
            if (currentPrice < peakProfitPrice) {
                this.position.peakProfitPrice = currentPrice; // New low-water mark
                this.logger.info(`[${this.getName()}] New peak profit price: ${currentPrice}`);
            } else {
                const drawdown = currentPrice - peakProfitPrice;
                if (drawdown >= this.bot.config.adverseMovementThreshold) {
                    this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT TRIGGERED! Drawdown ${drawdown} >= ${this.bot.config.adverseMovementThreshold}. Exiting position.`);
                    shouldExit = true;
                }
            }
        }
        
        if (shouldExit) {
            this.exitPosition();
        }
    }

    async exitPosition() {
        this.logger.info(`[${this.getName()}] EXITING POSITION at market.`);
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        const orderData = { product_id: this.bot.config.productId, size: this.bot.config.orderSize, side: exitSide, order_type: 'market_order', reduce_only: true };
        
        try {
            const response = await this.bot.placeOrder(orderData);
            if (response.success) {
                this.logger.info(`[${this.getName()}] Exit market order placed successfully.`);
                this.position = null; // Reset position state
                this.bot.startCooldown();
            } else {
                throw new Error(JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
            // Consider more robust error handling here, e.g., retry or alert
        }
    }
}

module.exports = MomentumRiderStrategy;
