// strategies/BboBracketStrategy.js
// Version 8.1.0 - Added Price Aggression Offset for Slippage Control
const { v4: uuidv4 } = require('uuid');

class BboBracketStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
    }

    getName() { return "BboBracketStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
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
            
            const bboPrice = parseFloat(book[0][0]);
            
            // --- SLIPPAGE CONTROL ---
            // Calculate an aggressive limit price to increase fill probability.
            const aggressionOffset = side === 'buy' 
                ? this.bot.config.priceAggressionOffset 
                : -this.bot.config.priceAggressionOffset;
            const aggressiveLimitPrice = bboPrice + aggressionOffset;
            
            this.logger.info(`[${this.getName()}] Applying aggression offset: BBO price is ${bboPrice}, placing limit at ${aggressiveLimitPrice.toFixed(4)}`);

            // Calculate TP/SL based on the new aggressive price.
            const takeProfitPrice = side === 'buy' ? aggressiveLimitPrice + this.bot.config.takeProfitOffset : aggressiveLimitPrice - this.bot.config.takeProfitOffset;
            const stopLossPrice = side === 'buy' ? aggressiveLimitPrice - this.bot.config.stopLossOffset : aggressiveLimitPrice + this.bot.config.stopLossOffset;

            if (takeProfitPrice <= 0 || stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid bracket price (<= 0).`, { aggressiveLimitPrice, takeProfitPrice, stopLossPrice });
                return;
            }
            
            const orderData = {
                product_id: this.bot.config.productId, size: this.bot.config.orderSize, side,
                order_type: 'limit_order', 
                limit_price: aggressiveLimitPrice.toString(), // Use the aggressive price
                client_order_id: clientOrderId,
                bracket_take_profit_price: takeProfitPrice.toString(),
                bracket_stop_loss_price: stopLossPrice.toString(),
            };
            
            const response = await this.bot.placeOrder(orderData);

            if (response.success && response.result) {
                this.logger.info(`[${this.getName()}] Main order placement successful. Waiting for TP/SL updates.`);
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
