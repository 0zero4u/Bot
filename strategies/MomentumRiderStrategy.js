// strategies/MomentumRiderStrategy.js
// Version 1.2.0 - Corrected API Parameter Data Types

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
        // ... (logic to determine side is the same)
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = side === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            this.logger.info(`[${this.getName()}] ENTERING POSITION with protected limit, side: ${side}, price: ${protectedLimitPrice.toFixed(4)}`);
            
            // --- FIX: Ensure numeric types for API parameters ---
            const orderData = { 
                product_id: this.bot.config.productId, // Stays as number (integer)
                size: this.bot.config.orderSize,       // Stays as number (integer)
                side, 
                order_type: 'limit_order',
                limit_price: protectedLimitPrice         // CORRECTED: Pass as a number
            };
            const response = await this.bot.placeOrder(orderData);
            
            if (response.success) {
                this.logger.info(`[${this.getName()}] Entry order placed. Waiting for fill.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else {
                // Log the detailed error from the exchange
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place entry order:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    manageOpenPosition(currentPrice) { /* ... same as before ... */ }

    async exitPosition() {
        // ... (logic to determine exitSide is the same)
        try {
            const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
            const book = exitSide === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for exit side '${exitSide}'.`);
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = exitSide === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;
            
            // --- FIX: Ensure numeric types for API parameters ---
            const orderData = { 
                product_id: this.bot.config.productId, // Stays as number (integer)
                size: this.bot.config.orderSize,       // Stays as number (integer)
                side: exitSide, 
                order_type: 'limit_order',
                limit_price: protectedLimitPrice,        // CORRECTED: Pass as a number
                reduce_only: true 
            };
            
            this.logger.info(`[${this.getName()}] Placing exit order with protected limit at ${protectedLimitPrice.toFixed(4)}`);

            const response = await this.bot.placeOrder(orderData);
            if (response.success) {
                this.logger.info(`[${this.getName()}] Exit order placed successfully.`);
                this.position = null;
                this.bot.startCooldown();
            } else {
                // Log the detailed error from the exchange
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
        }
    }
}

module.exports = MomentumRiderStrategy;
