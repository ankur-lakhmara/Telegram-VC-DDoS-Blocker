'use strict';
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(30);
module.exports = bus;
