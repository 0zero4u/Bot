// strategies/MomentumRiderStrategy.js
// Version 1.9.0 - MIGRATED TO SIGNAL-BASED STOP-LOSS
// This version uses the signal price for stop-loss calculations to prevent P&L-based exits.

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        // This will temporarily hold the signal price that triggered a potential entry.
        this.lastEntrySignalPrice = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            // If a position is open, use the latest price to manage it.
            this.manageOpenPosition(currentPrice);
        } else {
            // If no position is open, let the core trader logic decide if we can enter.
            await this.tryEnterPosition(currentPrice);
        }
    }

    onPositionUpdate(positionUpdate) {
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        // A new position has been confirmed on the exchange
        if (positionIsOpen && !this.position) {
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell',
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize),
                // Permanently attach the signal price to the position object
                entrySignalPrice: this.lastEntrySignalPrice
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION SYNCED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}, Entry Signal Price=${this.position.entrySignalPrice}`);
        
        // The position has been confirmed closed on the exchange
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            // Reset the temporary signal price holder
            this.lastEntrySignalPrice = null;
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
                // Store the price that triggered this successful order
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

    /**
     * CORRECTED LOGIC: This function now checks for adverse movement based on the initial
     * signal price, not the P&L from the exchange-filled entry price.
     */
    manageOpenPosition(currentPrice) {
        // Guard clauses: Do nothing if no position, exit is busy, or we don't have the entry signal price.
        if (!this.position || this.isExitInProgress || !this.position.entrySignalPrice) {
            // Log a warning if the signal price is missing, as stop-loss is disabled for this trade.
            if (this.position && !this.position.entrySignalPrice) {
                this.logger.warn(`[${this.getName()}] Cannot manage position because entrySignalPrice is missing. This can happen on bot restart with an existing position.`);
            }
            return;
        }

        let adverseMovement = 0;

        // Calculate the price movement against the direction of the trade using ONLY signal prices.
        if (this.position.side === 'buy') {
            // For a 'buy' position, adverse movement is how much the price has DROPPED.
            adverseMovement = this.position.entrySignalPrice - currentPrice;
        } else { // 'sell'
            // For a 'sell' position, adverse movement is how much the price has RISEN.
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
