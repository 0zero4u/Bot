// strategies/MomentumRiderStrategy.js
// Version 1.3.0 - Added breadcrumb logging for deep debugging

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null; // To track the open position state
    }

    getName() { return "MomentumRiderStrategy"; }

    /**
     * Main entry point for the strategy, called from the bot's signal handler.
     */
    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            // If we already have a position, manage it
            this.manageOpenPosition(currentPrice);
        } else {
            // If no position, check if we should enter one
            await this.tryEnterPosition(currentPrice);
        }
    }
    
    /**
     * Handles order updates from the WebSocket stream to track our position.
     */
    onOrderUpdate(order) {
        if (order.state === 'filled' && !this.position) {
            // Our entry order was filled, so we now have a position
            this.position = {
                side: order.side,
                entryPrice: parseFloat(order.avg_fill_price)
            };
            this.logger.info(`[${this.getName()}] POSITION OPENED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}`);
        }
    }

    /**
     * Attempts to enter a new position if market conditions are met.
     */
    async tryEnterPosition(currentPrice) {
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            this.logger.info(`[${this.getName()}] --- STEP 1: Entered the 'tryEnterPosition' block.`);

            // --- SLIPPAGE CONTROL (ENTRY) ---
            const book = side === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) {
                throw new Error(`No L1 order book data available for entry side '${side}'.`);
            }
            const bboPrice = parseFloat(book[0][0]);
            const protectionOffset = side === 'buy' ? this.bot.config.slippageProtectionOffset : -this.bot.config.slippageProtectionOffset;
            const protectedLimitPrice = bboPrice + protectionOffset;

            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'limit_order',
                limit_price: protectedLimitPrice.toString() // API expects price as a string
            };

            this.logger.info(`[${this.getName()}] --- STEP 2: Order data prepared. About to place entry order.`, { orderData });

            const response = await this.bot.placeOrder(orderData);
            
            this.logger.info(`[${this.getName()}] --- STEP 3: API call completed.`, { response });

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Entry order placed successfully. Waiting for fill.`);
                this.bot.priceAtLastTrade = currentPrice; // Update baseline price only on successful placement
            } else {
                throw new Error(`Exchange rejected order or returned unexpected format: ${JSON.stringify(response)}`);
            }

        } catch (error) {
            this.logger.error(`[${this.getName()}] --- STEP 4 (FAIL): Caught an error in 'tryEnterPosition'.`, { message: error.message, stack: error.stack });
        } finally {
            this.logger.info(`[${this.getName()}] --- STEP 5: Executing 'finally' block. Resetting flag.`);
            // This is critical: always reset the flag so the bot can trade again.
            this.bot.isOrderInProgress = false;
        }
    }

    /**
     * Monitors an open position and decides if it should be closed.
     */
    manageOpenPosition(currentPrice) {
        if (!this.position) return;

        const pnl = (currentPrice - this.position.entryPrice) * (this.position.side === 'buy' ? 1 : -1);
        const adverseMovement = -pnl; // PnL is negative when price moves against us

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold of $${this.bot.config.adverseMovementThreshold} met. Exiting position.`, { currentPrice, adverseMovement });
            this.exitPosition();
        }
    }

    /**
     * Places a reduce-only order to exit the current position.
     */
    async exitPosition() {
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
            this.logger.info(`[${this.getName()}] --- EXIT STEP 1: Entered 'exitPosition' block.`);
            
            // --- SLIPPAGE CONTROL (EXIT) ---
            const book = exitSide === 'buy' ? this.bot.orderBook.asks : this.bot.orderBook.bids;
            if (!book?.[0]?.[0]) {
                throw new Error(`No L1 order book data available for exit side '${exitSide}'.`);
            }
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
            
            this.logger.info(`[${this.getName()}] --- EXIT STEP 2: About to place exit order.`, { orderData });

            const response = await this.bot.placeOrder(orderData);
            
            this.logger.info(`[${this.getName()}] --- EXIT STEP 3: API call completed.`, { response });

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Exit order placed successfully.`);
                this.position = null; // Clear position state
                this.bot.startCooldown(); // Start cooldown after a successful exit
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] --- EXIT STEP 4 (FAIL): Caught an error in 'exitPosition'.`, { message: error.message, stack: error.stack });
            // If exit fails, we don't clear the position so we can try again.
        }
    }
}

module.exports = MomentumRiderStrategy;
