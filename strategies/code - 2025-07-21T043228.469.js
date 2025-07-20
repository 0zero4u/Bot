// strategies/MomentumRiderStrategy.js
// Version 1.5.0 - FINAL PRODUCTION VERSION

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
            await this.tryEnterPosition(currentPrice);
        }
    }

    onOrderUpdate(order) {
        // This can serve as a secondary confirmation if needed, but onPositionUpdate is primary.
        const isOrderFilled = order.state === 'filled' || (order.state === 'closed' && order.unfilled_size === 0);
        if (isOrderFilled && !this.position && order.product_id === this.bot.config.productId) {
            this.logger.info(`[${this.getName()}] Order update confirmed a new position.`);
            this.onPositionUpdate({ // Synthesize a position update object
                size: order.size,
                side: order.side,
                entry_price: order.avg_fill_price
            });
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

            this.logger.info(`[${this.getName()}] Placing entry order...`, { side, price: protectedLimitPrice });
            const response = await this.bot.placeOrder(orderData);

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Entry order placed successfully.`);
                this.bot.priceAtLastTrade = currentPrice;
                this.bot.startCooldown(); // <<< CRITICAL FIX FOR LOOPING
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
        if (!this.position) return;

        const pnl = (currentPrice - this.position.entryPrice) * (this.position.side === 'buy' ? 1 : -1);
        const adverseMovement = -pnl;

        if (adverseMovement >= this.bot.config.adverseMovementThreshold) {
            this.logger.warn(`[${this.getName()}] ADVERSE MOVEMENT threshold met. Exiting position.`);
            this.exitPosition();
        }
    }

    async exitPosition() {
        if (!this.position) return;
        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
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
            
            this.logger.info(`[${this.getName()}] Placing exit order...`);
            const response = await this.bot.placeOrder(orderData);

            if (response && response.result) {
                this.logger.info(`[${this.getName()}] Exit order placed successfully.`);
                // State will be cleared by the onPositionUpdate hook.
            } else {
                throw new Error(`Exchange rejected exit order: ${JSON.stringify(response)}`);
            }
        } catch (error) {
            this.logger.error(`[${this.getName()}] Failed to place exit order:`, { message: error.message });
        }
    }
}

module.exports = MomentumRiderStrategy;