// strategies/MomentumRiderStrategy.js
// Version 1.4.0 - Final Production Version with State-Sync Fix

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
     * This now correctly handles orders that are immediately filled and closed.
     */
    onOrderUpdate(order) {
        // A position is entered if our entry order fills. This can happen in two ways:
        // 1. A resting limit order is partially or fully filled (state: 'filled').
        // 2. A limit order acts as a taker and is filled and closed instantly (state: 'closed', unfilled_size: 0).
        const isOrderFilled = order.state === 'filled' || (order.state === 'closed' && order.unfilled_size === 0);

        // Only create the position object if it doesn't already exist and the order was filled.
        if (isOrderFilled && !this.position) {
            // Check if the filled order matches the product this bot is trading.
            if (order.product_id !== this.bot.config.productId) {
                return;
            }

            this.position = {
                side: order.side,
                entryPrice: parseFloat(order.avg_fill_price),
                size: parseFloat(order.size)
            };
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CONFIRMED: Side=${this.position.side}, Entry Price=${this.position.entryPrice}`);
        }
    }

    /**
     * Attempts to enter a new position if market conditions are met.
     */
    async tryEnterPosition(currentPrice) {
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            this.logger.info(`[${this.getName()}] --- STEP 1: Entered the 'tryEnterPosition' block.`);

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
                this.bot.priceAtLastTrade = currentPrice;
            } else {
                throw new Error(`Exchange rejected order or returned unexpected format: ${JSON.stringify(response)}`);
            }

        } catch (error) {
            this.logger.error(`[${this.getName()}] --- STEP 4 (FAIL): Caught an error in 'tryEnterPosition'.`, { message: error.message });
        } finally {
            this.logger.info(`[${this.getName()}] --- STEP 5: Executing 'finally' block. Resetting flag.`);
            this.bot.isOrderInProgress = false;
        }
    }

    /**
     * Monitors an open position and decides if it should be closed.
     */
    manageOpenPosition(currentPrice) {
        if (!this.position) return;

        const pnl = (currentPrice - this.position.entryPrice) * (this.position.side === 'buy' ? 1 : -1);
        const adverseMovement = -pnl;

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold of $${this.bot.config.adverseMovementThreshold} met. Exiting position.`, { currentPrice, adverseMovement });
            this.exitPosition();
        }
    }

    /**
     * Places a reduce-only order to exit the current position.
     */
    async exitPosition() {
        if (!this.position) {
            this.logger.warn(`[${this.getName()}] 'exitPosition' called, but no position exists. Ignoring.`);
            return;
        }

        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
            this.logger.info(`[${this.getName()}] --- EXIT STEP 1: Entered 'exitPosition' block.`);
            
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
                this.bot.startCooldown();
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] --- EXIT STEP 4 (FAIL): Caught an error in 'exitPosition'.`, { message: error.message });
        }
    }
}

module.exports = MomentumRiderStrategy;
