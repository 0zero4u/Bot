// strategies/TrailingStopStrategy.js
// NOTE: This strategy assumes the exchange supports placing trailing stop orders natively.
const { v4: uuidv4 } = require('uuid');

class TrailingStopStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "TrailingStopStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const bboPrice = parseFloat(book[0][0]);

            const protectionOffset = side === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            const orderData = {
                product_id: this.bot.config.productId,
                size: this.bot.config.orderSize,
                side,
                order_type: 'limit_order',
                limit_price: protectedLimitPrice.toString(),
                stop_order_type: 'trailing_stop_order', // Exchange-specific parameter
                trail_amount: this.bot.config.trailAmount.toString(), // Exchange-specific parameter
                client_order_id: uuidv4(),
            };
            
            this.logger.info(`[${this.getName()}] Placing protected limit order at ${protectedLimitPrice.toFixed(4)} with native trailing stop amount: ${this.bot.config.trailAmount}`);
            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
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
module.exports = TrailingStopStrategy;
