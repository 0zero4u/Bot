// strategies/BboBracketStrategy.js
const { v4: uuidv4 } = require('uuid');

class BboBracketStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "BboBracketStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        this.bot.isOrderInProgress = true;
        try {
            this.logger.info(`[${this.getName()}] TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const limitPrice = parseFloat(book[0][0]);
            
            const takeProfitPrice = side === 'buy' ? limitPrice + this.bot.config.takeProfitOffset : limitPrice - this.bot.config.takeProfitOffset;
            const stopLossPrice = side === 'buy' ? limitPrice - this.bot.config.stopLossOffset : limitPrice + this.bot.config.stopLossOffset;

            if (takeProfitPrice <= 0 || stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Calculated bracket price is invalid (<= 0). Check offsets.`, { limitPrice, takeProfitPrice, stopLossPrice });
                return;
            }
            
            const orderData = {
                product_id: this.bot.config.productId, size: this.bot.config.orderSize, side,
                order_type: 'limit_order', limit_price: limitPrice.toString(), client_order_id: clientOrderId,
                bracket_take_profit_price: takeProfitPrice.toString(),
                bracket_stop_loss_price: stopLossPrice.toString(),
            };
            
            const response = await this.bot.placeOrder(orderData);
            if (response.success && Array.isArray(response.result)) {
                this.logger.info(`[${this.getName()}] Bracket order placement successful.`);
                response.result.forEach(order => this.bot.registerOrder(order, order.order_type, clientOrderId));
                this.bot.priceAtLastTrade = currentPrice;
                this.bot.startCooldown();
            } else {
                 throw new Error('API call failed or returned unexpected format: ' + JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to execute trade:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = BboBracketStrategy;
