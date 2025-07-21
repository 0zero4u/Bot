// strategies/BboBracketStrategy.js
// This strategy places a main order and relies on the trader to manage the TP/SL bracket.
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
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            
            const bboPrice = parseFloat(book[0][0]);
            const aggressionOffset = side === 'buy' ? this.bot.config.priceAggressionOffset : -this.bot.config.priceAggressionOffset;
            const aggressiveLimitPrice = bboPrice + aggressionOffset;
            
            const orderData = {
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side,
                order_type: 'limit_order', 
                limit_price: aggressiveLimitPrice.toString(),
                client_order_id: clientOrderId,
            };
            
            this.logger.info(`[${this.getName()}] Placing main bracket order at ${aggressiveLimitPrice.toFixed(4)}.`);
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Main order placement successful. Handing off to OrderManager.`);
                // CRITICAL: Register the order with the trader for bracket management.
                this.bot.registerOrder(response.result, 'main', clientOrderId);
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
