// strategies/MomentumRiderStrategy.js
// Version 1.6.0 - FINAL PRODUCTION VERSION with Exit Loop Fix

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false; // <<< NEW: Add the exit flag
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
            await this.tryEnterPosition(currentPrice);
        }
    }

    onPositionUpdate(positionUpdate) {
        const positionIsOpen = positionUpdate.size !== 0;
        const strategyIsUnaware = !this.position;

        if (positionIsOpen && strategyIsUnaware) {
            this.position = {
                side: positionUpdate.side,
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: parseFloat(positionUpdate.size)
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}`);
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false; // <<< NEW: Reset flag when position is confirmed closed
        }
    }

    async tryEnterPosition(currentPrice) {
        // ... (This function remains the same as the previous version)
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = side === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'limit_order',
                limit_price: protectedLimitPrice.toString()
            };

            this.logger.info(`[${this.getName()}] Placing entry order...`);
            const response = await this.bot.placeOrder(orderData);

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Entry order placed successfully.`);
                this.bot.priceAtLastTrade = currentPrice;
                this.bot.startCooldown();
            } else {
                throw new Error(`Exchange rejected order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to enter position:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    manageOpenPosition(currentPrice) {
        if (!this.position || this.isExitInProgress) { // <<< NEW: Check the flag here
            return;
        }

        const pnl = (currentPrice - this.position.entryPrice) * (this.position.side === 'buy' ? 1 : -1);
        const adverseMovement = -pnl;

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold met. Attempting to exit position.`);
            this.exitPosition(); // This will now only run once per attempt
        }
    }

    async exitPosition() {
        if (!this.position) return;

        this.isExitInProgress = true; // <<< NEW: Set flag to prevent looping
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';

        try {
            this.logger.info(`[${this.getName()}] Placing exit order...`);
            
            const book = exitSide === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for exit side '${exitSide}'.`);
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = exitSide === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side: exitSide, 
                order_type: 'limit_order',
                limit_price: protectedLimitPrice.toString(),
                reduce_only: true 
            };
            
            const response = await this.bot.placeOrder(orderData);

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Exit order placed successfully. Waiting for confirmation.`);
                // The 'isExitInProgress' flag will be reset by onPositionUpdate when the position closes.
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
            this.isExitInProgress = false; // <<< NEW: Reset flag on failure to allow a retry
        }
    }
}

module.exports = MomentumRiderStrategy;
