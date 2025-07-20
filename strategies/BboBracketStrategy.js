// strategies/BboBracketStrategy.js
// Version 8.0.1 - Corrected API response handling for bracket orders.
const { v4: uuidv4 } = require('uuid');

class BboBracketStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "BboBracketStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        // This strategy requires the price difference, so we check it
        if (priceDifference < this.bot.config.priceThreshold) {
            return;
        }

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

            // --- THE DEFINITIVE FIX ---
            // The API returns a single object for the main order, not an array.
            if (response.success && response.result) {
                this.logger.info(`[${this.getName()}] Main order placement successful. Waiting for TP/SL updates via WebSocket.`);
                
                // Register the main order. The children (TP/SL) will be linked asynchronously
                // by the main trader.js 'handleOrderUpdate' function when they arrive.
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
