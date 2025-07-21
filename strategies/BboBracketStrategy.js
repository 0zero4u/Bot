// strategies/BboBracketStrategy.js
// Version 8.2.0 - Works with client-side bracket management and is race-condition safe.
const { v4: uuidv4 } = require('uuid');

class BboBracketStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "BboBracketStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        this.bot.isOrderInProgress = true;
        const clientOrderId = uuidv4(); // Generate ID before any async operation
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
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
            
            // --- RACE CONDITION FIX ---
            // Register the intent to manage this order *before* placing it.
            // This ensures the trader is ready to catch the websocket update.
            this.bot.registerPendingOrder(clientOrderId);
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                // Confirm the order with the trader so it can be fully managed.
                this.bot.confirmRegisteredOrder(clientOrderId, response.result);
                this.logger.info(`[${this.getName()}] Main order placement successful. Handing off to OrderManager.`);
                this.bot.priceAtLastTrade = currentPrice;
                this.bot.startCooldown();
            } else {
                 // If the order fails, cancel the pending registration.
                 this.bot.cancelPendingOrder(clientOrderId);
                 throw new Error('API call failed or returned unexpected format: ' + JSON.stringify(response));
            }
        } catch (error) {
            this.bot.cancelPendingOrder(clientOrderId); // Also cancel on any error
            this.logger.error(`[${this.getName()}] Failed to execute trade:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}
module.exports = BboBracketStrategy;
