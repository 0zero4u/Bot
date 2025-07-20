// strategies/TrailingStopStrategy.js
// Version 1.1.0 - Converted Market Order to Protected Limit Order for Slippage Control
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
            const side = currentPrice > this.bot.config.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            
            const bboPrice = parseFloat(book[0][0]);

            // --- SLIPPAGE CONTROL: CONVERT MARKET TO PROTECTED LIMIT ---
            const protectionOffset = side === 'buy'
                ? this.bot.config.slippageProtectionOffset
                : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            // This strategy now uses a protected limit order to enter, and a trailing stop to exit.
            const orderData = {
                product_id: this.bot.config.productId,
                size: this.bot.config.orderSize,
                side,
                order_type: 'limit_order', // CHANGED from 'market_order'
                limit_price: protectedLimitPrice.toString(), // ADDED for protection
                stop_order_type: 'trailing_stop_order',
                trail_amount: this.bot.config.trailAmount.toString(),
                client_order_id: clientOrderId,
            };
            
            this.logger.info(`[${this.getName()}] Placing PROTECTED LIMIT order at ${protectedLimitPrice.toFixed(4)} with trailing stop amount: ${this.bot.config.trailAmount}`);
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
