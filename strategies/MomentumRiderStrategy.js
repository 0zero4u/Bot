// strategies/MomentumRiderStrategy.js
// Version 1.9.1 - Refined logging for existing positions on restart.

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        this.lastEntrySignalPrice = null;
        // --- NEW: Flag to prevent log flooding ---
        this.hasWarnedAboutMissingSignalPrice = false;
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
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        if (positionIsOpen && !this.position) {
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell',
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize),
                entrySignalPrice: this.lastEntrySignalPrice
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}, Entry Signal Price=${this.position.entrySignalPrice}`);
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            this.lastEntrySignalPrice = null;
            // --- NEW: Reset the warning flag when the position is closed ---
            this.hasWarnedAboutMissingSignalPrice = false;
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
                this.lastEntrySignalPrice = currentPrice;
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
        // --- MODIFIED: The guard clause logic is now improved ---
        if (!this.position || this.isExitInProgress) {
            return;
        }

        // Handle the specific case of a missing entry signal price
        if (!this.position.entrySignalPrice) {
            // Only log the warning if we haven't already.
            if (!this.hasWarnedAboutMissingSignalPrice) {
                this.logger.warn(`[${this.getName()}] Cannot manage position because entrySignalPrice is missing. This can happen on bot restart with an existing position. The stop-loss will not be active for this trade.`);
                this.hasWarnedAboutMissingSignalPrice = true; // Set the flag to prevent re-logging
            }
            return; // Exit the function
        }

        let adverseMovement = 0;

        if (this.position.side === 'buy') {
            adverseMovement = this.position.entrySignalPrice - currentPrice;
        } else { // 'sell'
            adverseMovement = currentPrice - this.position.entrySignalPrice;
        }

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold met based on signal price. Current: ${currentPrice}, Entry Signal: ${this.position.entrySignalPrice}. Attempting to exit.`);
            this.exitPosition();
        }
    }

    async exitPosition() {
        if (!this.position) return;
        this.isExitInProgress = true;
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
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
            this.isExitInProgress = false; 
        }
    }
}

module.exports = MomentumRiderStrategy;
