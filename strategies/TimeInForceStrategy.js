// strategies/TimeInForceStrategy.js
// Version 1.1.0 - Added Price Aggression Offset for Slippage Control
const { v4: uuidv4 } = require('uuid');

class TimeInForceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "TimeInForceStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        this.bot.isOrderInProgress = true;
        try {
            this.logger.info(`[${this.getName()}] TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            
            const bboPrice = parseFloat(book[0][0]);

            // --- SLIPPAGE CONTROL ---
            const aggressionOffset = side === 'buy' 
                ? this.bot.config.priceAggressionOffset 
                : -this.bot.config.priceAggressionOffset;
            const aggressiveLimitPrice = bboPrice + aggressionOffset;

            const orderData = {
                product_id: this.bot.config.productId, size: this.bot.config.orderSize, side,
                order_type: 'limit_order', 
                limit_price: aggressiveLimitPrice.toString(), // Use the aggressive price
                client_order_id: clientOrderId,
                time_in_force: this.bot.config.timeInForce,
            };
            
            this.logger.info(`[${this.getName()}] Applying aggression offset. BBO: ${bboPrice}, Placing aggressive limit order at ${aggressiveLimitPrice.toFixed(4)} with TIF: ${this.bot.config.timeInForce}`);
            const response = await this.bot.placeOrder(orderData);
            
            if (response.success) {
                this.logger.info(`[${this.getName()}] Order placement successful.`);
                this.bot.priceAtLastTrade = currentPrice;
                this.bot.startCooldown();
            } else {
                 throw new Error('API call failed: ' + JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to execute trade:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = TimeInForceStrategy;
