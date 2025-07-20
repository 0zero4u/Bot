// strategies/MomentumRiderStrategy.js
// Version 1.7.0 - FINAL PRODUCTION VERSION

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false; // Flag to prevent exit loops
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
            // Only try to enter if we are not in cooldown from a previous trade
            if (!this.bot.isCoolingDown && !this.bot.isOrderInProgress) {
                await this.tryEnterPosition(currentPrice);
            }
        }
    }

    /**
     * This is the primary and most reliable way to sync the strategy's state with the exchange.
     */
    onPositionUpdate(positionUpdate) {
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        if (positionIsOpen && !this.position) {
            // --- FIX: Correctly derive the side from the position size ---
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell', // DERIVE from size, not a non-existent field
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize) // Always use a positive size for internal tracking
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}`);
        } else if (!positionIsOpen && this.position) {
            // Position is now confirmed closed, reset everything.
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false; // Reset the exit flag
        }
    }

    async tryEnterPosition(currentPrice) {
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
                this.bot.startCooldown(); // <<< CRITICAL: Start cooldown to allow state to sync
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
        if (!this.position || this.isExitInProgress) {
            return; // Don't do anything if we have no position or are already trying to exit.
        }

        const pnl = (currentPrice - this.position.entryPrice) * (this.position.side === 'buy' ? 1 : -1);
        const adverseMovement = -pnl;

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold met. Attempting to exit position.`);
            this.exitPosition();
        }
    }

    async exitPosition() {
        if (!this.position) return;

        this.isExitInProgress = true; // Set flag to prevent looping
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
                this.logger.info(`[${this.getName()}] Exit order placed successfully. Waiting for position update to confirm closure.`);
                // The 'isExitInProgress' flag will now be reliably reset by onPositionUpdate when the position is confirmed closed.
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
            // On failure, we now allow the bot to retry on the next tick if needed, but the flag prevents spamming.
            this.isExitInProgress = false; 
        }
    }
}

module.exports = MomentumRiderStrategy;
