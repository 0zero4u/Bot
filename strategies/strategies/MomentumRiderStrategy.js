// strategies/MomentumRiderStrategy.js
// Version 1.1.0 - Converted Market Orders to Protected Limit Orders for Slippage Control
class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    onOrderUpdate(order) { /* ... same as before ... */ }

    async onPriceUpdate(currentPrice) { /* ... same as before ... */ }
    
    async tryEnterPosition(currentPrice) {
        const priceDifference = Math.abs(currentPrice - this.bot.priceAtLastTrade);
        if (priceDifference < this.bot.config.priceThreshold) return;

        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            // --- SLIPPAGE CONTROL (ENTRY) ---
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = side === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            this.logger.info(`[${this.getName()}] ENTERING POSITION with protected limit, side: ${side}, price: ${protectedLimitPrice.toFixed(4)}`);
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'limit_order', // CHANGED
                limit_price: protectedLimitPrice.toString() // ADDED
            };
            const response = await this.bot.placeOrder(orderData);
            
            if (response.success) {
                this.logger.info(`[${this.getName()}] Entry order placed. Waiting for fill.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else {
                throw new Error(JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place entry order:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    manageOpenPosition(currentPrice) { /* ... same as before ... */ }

    async exitPosition() {
        this.logger.info(`[${this.getName()}] EXITING POSITION.`);
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';

        try {
            // --- SLIPPAGE CONTROL (EXIT) ---
            const book = exitSide === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for exit side '${exitSide}'.`);
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = exitSide === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;
            
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side: exitSide, 
                order_type: 'limit_order', // CHANGED
                limit_price: protectedLimitPrice.toString(), // ADDED
                reduce_only: true 
            };
            
            this.logger.info(`[${this.getName()}] Placing exit order with protected limit at ${protectedLimitPrice.toFixed(4)}`);

            const response = await this.bot.placeOrder(orderData);
            if (response.success) {
                this.logger.info(`[${this.getName()}] Exit order placed successfully.`);
                this.position = null;
                this.bot.startCooldown();
            } else {
                throw new Error(JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
        }
    }
}

module.exports = MomentumRiderStrategy;
