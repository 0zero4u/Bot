// strategies/TrailingStopStrategy.js
// Version 2.1.0 - Corrected native trailing stop logic to align with API docs.
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

            // --- CORRECTED ---
            // A native trailing stop is created by setting a 'trail_amount' on a stop order.
            // It does not use 'limit_price' or 'limit_order' type.
            // We set the order_type to 'market_order' to create a trailing stop-market order.
            const orderData = {
                product_id: this.bot.config.productId,
                size: this.bot.config.orderSize,
                side,
                order_type: 'market_order', // This defines what happens when the trail is hit.
                stop_order_type: 'trailing_stop', // Use the correct enum for a trailing stop.
                trail_amount: this.bot.config.trailAmount.toString(),
                client_order_id: uuidv4(),
            };
            
            this.logger.info(`[${this.getName()}] Placing native trailing stop order with trail amount: ${this.bot.config.trailAmount}`);
            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
                this.logger.info(`[${this.getName()}] Trailing stop order placement successful.`);
                this.bot.priceAtLastTrade = currentPrice;
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
