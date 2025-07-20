// strategies/TrailingStopStrategy.js
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
            this.logger.info(`[${this.getName()}] TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const limitPrice = parseFloat(book[0][0]);
            
            // This strategy uses a market order to enter and a trailing stop to exit.
            const orderData = {
                product_id: this.bot.config.productId,
                size: this.bot.config.orderSize,
                side,
                order_type: 'market_order', // Enter with a market order for speed
                stop_order_type: 'trailing_stop_order', // This makes it a trailing stop
                trail_amount: this.bot.config.trailAmount.toString(), // The key parameter
                client_order_id: clientOrderId,
            };
            
            this.logger.info(`[${this.getName()}] Placing market order with trailing stop amount: ${this.bot.config.trailAmount}`);
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

module.exports = TrailingStopStrategy;
