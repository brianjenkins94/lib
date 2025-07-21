import { EventEmitter } from "./events";

const STRATEGY = {
    LEAK: 1,
    OVERFLOW: 2,
    OVERFLOW_PRIORITY: 4,
    BLOCK: 3
};

const NUM_PRIORITIES = 10;

const DEFAULT_PRIORITY = 5;

class Job extends EventEmitter {
    constructor(task, args, options, rejectOnDrop, _states) {
        super();
        this.task = task;
        this.args = args;
        this.rejectOnDrop = rejectOnDrop;
        this._states = _states;

        this.options = {
            priority: DEFAULT_PRIORITY,
            weight: 1,
            expiration: null,
            id: `${options.id ?? "<no-id>"}-${this._randomIndex()}`,
            ...options
        };

        this.options.priority = this._sanitizePriority(this.options.priority);
        this.promise = new Promise((_resolve, _reject) => {
            this._resolve = _resolve;
            this._reject = _reject;
        });
        this.retryCount = 0;
    }

    _sanitizePriority(priority) {
        let sProperty = ~~priority !== priority ? DEFAULT_PRIORITY : priority;
        if (sProperty < 0) {
            return 0;
        } else if (sProperty > NUM_PRIORITIES - 1) {
            return NUM_PRIORITIES - 1;
        } else {
            return sProperty;
        }
    }

    _randomIndex() {
        return Math.random().toString(36).slice(2);
    }

    doDrop({
        error,
        message = "This job has been dropped by Bottleneck"
    } = {}) {
        if (this._states.remove(this.options.id)) {
            if (this.rejectOnDrop) {
                this._reject(error != null ? error : new Error(message));
            }
            this.emit("dropped", {
                args: this.args,
                options: this.options,
                task: this.task,
                promise: this.promise
            });
            return true;
        } else {
            return false;
        }
    }

    _assertStatus(expected) {
        let status = this._states.jobStatus(this.options.id);
        if (!(status === expected || (expected === "DONE" && status === null))) {
            throw new Error(`Invalid job status ${status}, expected ${expected}. Please open an issue at https://github.com/SGrondin/bottleneck/issues`);
        }
    }

    doReceive() {
        this._states.start(this.options.id);
        return this.emit("received", {
            args: this.args,
            options: this.options
        });
    }

    doQueue(reachedHWM, blocked) {
        this._assertStatus("RECEIVED");
        this._states.next(this.options.id);
        return this.emit("queued", {
            args: this.args,
            options: this.options,
            reachedHWM,
            blocked
        });
    }

    doRun() {
        if (this.retryCount === 0) {
            this._assertStatus("QUEUED");
            this._states.next(this.options.id);
        } else {
            this._assertStatus("EXECUTING");
        }
        return this.emit("scheduled", {
            args: this.args,
            options: this.options
        });
    }

    async doExecute(chained, clearGlobalState, run, free) {
        if (this.retryCount === 0) {
            this._assertStatus("RUNNING");
            this._states.next(this.options.id);
        } else {
            this._assertStatus("EXECUTING");
        }
        const eventInfo = {
            args: this.args,
            options: this.options,
            retryCount: this.retryCount
        };
        this.emit("executing", eventInfo);
        try {
            const passed = (await (chained != null ? chained.schedule(this.options, this.task, ...this.args) : this.task(...this.args)));
            if (clearGlobalState()) {
                this.doDone(eventInfo);
                await free(this.options, eventInfo);
                this._assertStatus("DONE");
                return this._resolve(passed);
            }
        } catch (error) {
            return this._onFailure(error, eventInfo, clearGlobalState, run, free);
        }
    }

    doExpire(clearGlobalState, run, free) {
        if (this._states.jobStatus(this.options.id === "RUNNING")) {
            this._states.next(this.options.id);
        }
        this._assertStatus("EXECUTING");
        const eventInfo = {
            args: this.args,
            options: this.options,
            retryCount: this.retryCount
        };
        const error = new Error(`This job timed out after ${this.options.expiration} ms.`);
        return this._onFailure(error, eventInfo, clearGlobalState, run, free);
    }

    async _onFailure(error, eventInfo, clearGlobalState, run, free) {
        if (clearGlobalState()) {
            const retry = (await this.emit("failed", error, eventInfo));
            if (retry != null) {
                const retryAfter = ~~retry;
                this.emit("retry", `Retrying ${this.options.id} after ${retryAfter} ms`, eventInfo);
                this.retryCount++;
                return run(retryAfter);
            } else {
                this.doDone(eventInfo);
                await free(this.options, eventInfo);
                this._assertStatus("DONE");
                return this._reject(error);
            }
        }
    }

    doDone(eventInfo) {
        this._assertStatus("EXECUTING");
        this._states.next(this.options.id);
        return this.emit("done", eventInfo);
    }
};

class LocalDatastore {
    constructor(instance, storeOptions) {
        this.instance = instance;
        this.storeOptions = storeOptions;
        this.clientId = this.instance._randomIndex();

        this._nextRequest = this._lastReservoirRefresh = this._lastReservoirIncrease = Date.now();
        this._running = 0;
        this._done = 0;
        this._unblockTime = 0;
        this.ready = Promise.resolve();
        this.clients = {};
        this._startHeartbeat();
    }

    _startHeartbeat() {
        let base;
        if ((this.heartbeat == null) && (((this.storeOptions.reservoirRefreshInterval != null) && (this.storeOptions.reservoirRefreshAmount != null)) || ((this.storeOptions.reservoirIncreaseInterval != null) && (this.storeOptions.reservoirIncreaseAmount != null)))) {
            return typeof (base = (this.heartbeat = setInterval(() => {
                let amount, incr, maximum, now, reservoir;
                now = Date.now();
                if ((this.storeOptions.reservoirRefreshInterval != null) && now >= this._lastReservoirRefresh + this.storeOptions.reservoirRefreshInterval) {
                    this._lastReservoirRefresh = now;
                    this.storeOptions.reservoir = this.storeOptions.reservoirRefreshAmount;
                    this.instance._drainAll(this.computeCapacity());
                }
                if ((this.storeOptions.reservoirIncreaseInterval != null) && now >= this._lastReservoirIncrease + this.storeOptions.reservoirIncreaseInterval) {
                    ({
                        reservoirIncreaseAmount: amount,
                        reservoirIncreaseMaximum: maximum,
                        reservoir
                    } = this.storeOptions);
                    this._lastReservoirIncrease = now;
                    incr = maximum != null ? Math.min(amount, maximum - reservoir) : amount;
                    if (incr > 0) {
                        this.storeOptions.reservoir += incr;
                        return this.instance._drainAll(this.computeCapacity());
                    }
                }
            }, this.heartbeatInterval))).unref === "function" ? base.unref() : undefined;
        } else {
            return clearInterval(this.heartbeat);
        }
    }

    yieldLoop(t = 0) {
        return new Promise(function(resolve, reject) {
            return setTimeout(resolve, t);
        });
    }

    computePenalty() {
        const ref = this.storeOptions.penalty
        return ref != null ? ref : (15 * this.storeOptions.minTime) || 5000;
    }
    computeCapacity() {
        const  { maxConcurrent, reservoir } = this.storeOptions;
        if ((maxConcurrent != null) && (reservoir != null)) {
            return Math.min(maxConcurrent - this._running, reservoir);
        } else if (maxConcurrent != null) {
            return maxConcurrent - this._running;
        } else if (reservoir != null) {
            return reservoir;
        } else {
            return null;
        }
    }

    conditionsCheck(weight) {
        const capacity = this.computeCapacity();
        return (capacity == null) || weight <= capacity;
    }

    isBlocked(now) {
        return this._unblockTime >= now;
    }

    check(weight, now) {
        return this.conditionsCheck(weight) && (this._nextRequest - now) <= 0;
    }

    async __register__(index, weight, expiration) {
        await this.yieldLoop();
        const now = Date.now();
        if (this.conditionsCheck(weight)) {
            this._running += weight;
            if (this.storeOptions.reservoir != null) {
                this.storeOptions.reservoir -= weight;
            }
            const wait = Math.max(this._nextRequest - now, 0);
            this._nextRequest = now + wait + this.storeOptions.minTime;
            return {
                success: true,
                wait,
                reservoir: this.storeOptions.reservoir
            };
        } else {
            return {
                success: false
            };
        }
    }

    strategyIsBlock() {
        return this.storeOptions.strategy === STRATEGY.BLOCK;
    }

    async __submit__(queueLength, weight) {
        var blocked, now, reachedHWM;
        await this.yieldLoop();
        if ((this.storeOptions.maxConcurrent != null) && weight > this.storeOptions.maxConcurrent) {
            throw new Error(`Impossible to add a job having a weight of ${weight} to a limiter having a maxConcurrent setting of ${this.storeOptions.maxConcurrent}`);
        }
        now = Date.now();
        reachedHWM = (this.storeOptions.highWater != null) && queueLength === this.storeOptions.highWater && !this.check(weight, now);
        blocked = this.strategyIsBlock() && (reachedHWM || this.isBlocked(now));
        if (blocked) {
            this._unblockTime = now + this.computePenalty();
            this._nextRequest = this._unblockTime + this.storeOptions.minTime;
            this.instance._dropAllQueued();
        }
        return {
            reachedHWM,
            blocked,
            strategy: this.storeOptions.strategy
        };
    }

    async __free__(index, weight) {
        await this.yieldLoop();
        this._running -= weight;
        this._done += weight;
        this.instance._drainAll(this.computeCapacity());
        return {
            running: this._running
        };
    }
};

class States {
    constructor(status1) {
        this.status = status1;
        this._jobs = {};
        this.counts = this.status.map(function() {
            return 0;
        });
    }

    next(id) {
        const current = this._jobs[id];
        const next = current + 1;
        if ((current != null) && next < this.status.length) {
            this.counts[current]--;
            this.counts[next]++;
            return this._jobs[id]++;
        } else if (current != null) {
            this.counts[current]--;
            return delete this._jobs[id];
        }
    }

    start(id) {
        const initial = 0;
        this._jobs[id] = initial;
        return this.counts[initial]++;
    }

    remove(id) {
        const current = this._jobs[id];
        if (current != null) {
            this.counts[current]--;
            delete this._jobs[id];
        }
        return current != null;
    }

    jobStatus(id) {
        const ref = this.status[this._jobs[id]];
        return ref != null ? ref : null;
    }
};

class Sync {
    constructor(name) {
        this.schedule = this.schedule.bind(this);
        this.name = name;
        this._running = 0;
        this._queue = [];
    }

    isEmpty() {
        return this._queue.length === 0;
    }

    async _tryToRun() {
        var args, cb, error, reject, resolve, returned, task;
        if ((this._running < 1) && this._queue.length > 0) {
            this._running++;
            ({
                task,
                args,
                resolve,
                reject
            } = this._queue.shift());
            cb = (await (async function() {
                try {
                    returned = (await task(...args));
                    return function() {
                        return resolve(returned);
                    };
                } catch (error1) {
                    error = error1;
                    return function() {
                        return reject(error);
                    };
                }
            })());
            this._running--;
            this._tryToRun();
            return cb();
        }
    }

    schedule(task, ...args) {
        let resolve = null, reject = null;
        const promise = new Promise(function(_resolve, _reject) {
            resolve = _resolve;
            return reject = _reject;
        });
        this._queue.push({
            task,
            args,
            resolve,
            reject
        });
        this._tryToRun();
        return promise;
    }
};

export class Bottleneck extends EventEmitter {
    constructor(options = {}) {
        super();

        this._addToQueue = this._addToQueue.bind(this);

        this.datastore = options.datastore ?? "local",
        this.id = options.id ?? "<no-id>",
        this.rejectOnDrop = options.rejectOnDrop ?? true,
        this.trackDoneStatus = options.trackDoneStatus ?? false

        this._queues = Array.from({ length: NUM_PRIORITIES }, () => []);
        this._queuesLength = 0;
        this._lastQueuesLength = 0;

        this._scheduled = {};
        this._states = new States(["RECEIVED", "QUEUED", "RUNNING", "EXECUTING", ...(this.trackDoneStatus ? ["DONE"] : [])]);
        this._limiter = null;
        this._submitLock = new Sync("submit");
        this._registerLock = new Sync("register");

        const storeOptions = {
            maxConcurrent: null,
            minTime: 0,
            highWater: null,
            strategy: STRATEGY.LEAK,
            penalty: null,
            reservoir: null,
            reservoirRefreshInterval: null,
            reservoirRefreshAmount: null,
            reservoirIncreaseInterval: null,
            reservoirIncreaseAmount: null,
            reservoirIncreaseMaximum: null,
            ...options
        };

        this._store = (function() {
            if (this.datastore === "local") {
                return new LocalDatastore(this, storeOptions);
            } else {
                throw new Error(`Invalid datastore type: ${this.datastore}`);
            }
        }).call(this);
    }

    queued(priority) {
        if (priority != null) {
            return this._queues[priority].length;
        } else {
            return this._queuesLength;
        }
    }

    empty() {
        return this.queued() === 0 && this._submitLock.isEmpty();
    }

    _randomIndex() {
        return Math.random().toString(36).slice(2);
    }

    _clearGlobalState(index) {
        if (this._scheduled[index] != null) {
            clearTimeout(this._scheduled[index].expiration);
            delete this._scheduled[index];
            return true;
        } else {
            return false;
        }
    }

    async _free(index, job, options, eventInfo) {
        var e, running;
        try {
            ({
                running
            } = (await this._store.__free__(index, options.weight)));
            this.emit("debug", `Freed ${options.id}`, eventInfo);
            if (running === 0 && this.empty()) {
                return this.emit("idle");
            }
        } catch (error1) {
            e = error1;
            return this.emit("error", e);
        }
    }

    _run(index, job, wait) {
        var clearGlobalState, free, run;
        job.doRun();
        clearGlobalState = this._clearGlobalState.bind(this, index);
        run = this._run.bind(this, index, job);
        free = this._free.bind(this, index, job);
        return this._scheduled[index] = {
            timeout: setTimeout(() => {
                return job.doExecute(this._limiter, clearGlobalState, run, free);
            }, wait),
            expiration: job.options.expiration != null ? setTimeout(function() {
                return job.doExpire(clearGlobalState, run, free);
            }, wait + job.options.expiration) : undefined,
            job: job
        };
    }

    _drainOne(capacity) {
        return this._registerLock.schedule(() => {
            // Find the first non-empty queue by priority
            let queue, next, options, args, priority;
            for (priority = 0; priority < NUM_PRIORITIES; priority++) {
                if (this._queues[priority].length > 0) {
                    queue = this._queues[priority];
                    break;
                }
            }
            if (!queue || queue.length === 0) {
                return Promise.resolve(null);
            }
            next = queue[0];
            ({ options, args } = next);
            if ((capacity != null) && options.weight > capacity) {
                return Promise.resolve(null);
            }
            this.emit("debug", `Draining ${options.id}`, {
                args,
                options
            });
            const index = this._randomIndex();
            return this._store.__register__(index, options.weight, options.expiration).then(({
                success,
                wait,
                reservoir
            }) => {
                var empty;
                this.emit("debug", `Drained ${options.id}`, {
                    success,
                    args,
                    options
                });
                if (success) {
                    queue.shift();
                    this._queuesLength--;
                    //this._emitZero();
                    if (this._lastQueuesLength > 0 && this._queuesLength === 0) {
                        var ref;
                        (ref = this._store.heartbeat) != null ? typeof ref.unref === "function" ? ref.unref() : undefined : undefined;
                    }
                    this._lastQueuesLength = this._queuesLength;

                    empty = this.empty();
                    if (empty) {
                        this.emit("empty");
                    }
                    if (reservoir === 0) {
                        this.emit("depleted", empty);
                    }
                    this._run(index, next, wait);
                    return Promise.resolve(options.weight);
                } else {
                    return Promise.resolve(null);
                }
            });
        });
    }

    _drainAll(capacity, total = 0) {
        return this._drainOne(capacity).then((drained) => {
            var newCapacity;
            if (drained != null) {
                newCapacity = capacity != null ? capacity - drained : capacity;
                return this._drainAll(newCapacity, total + drained);
            } else {
                return Promise.resolve(total);
            }
        }).catch((e) => {
            return this.emit("error", e);
        });
    }

    async _addToQueue(job) {
        var args, blocked, error, options, reachedHWM, shifted, strategy;
        ({
            args,
            options
        } = job);
        try {
            ({
                reachedHWM,
                blocked,
                strategy
            } = (await this._store.__submit__(this.queued(), options.weight)));
        } catch (error1) {
            error = error1;
            this.emit("debug", `Could not queue ${options.id}`, {
                args,
                options,
                error
            });
            job.doDrop({
                error
            });
            return false;
        }
        if (blocked) {
            job.doDrop();
            return true;
        } else if (reachedHWM) {
            // Handle overflow strategies
            if (strategy === STRATEGY.LEAK) {
                shifted = this._shiftLastFrom(options.priority);
            } else if (strategy === STRATEGY.OVERFLOW_PRIORITY) {
                shifted = this._shiftLastFrom(options.priority + 1);
            } else if (strategy === STRATEGY.OVERFLOW) {
                shifted = job;
            }
            if (shifted != null) {
                shifted.doDrop();
            }
            if ((shifted == null) || strategy === STRATEGY.OVERFLOW) {
                if (shifted == null) {
                    job.doDrop();
                }
                return reachedHWM;
            }
        }
        job.doQueue(reachedHWM, blocked);
        this._queues[job.options.priority].push(job);
        this._queuesLength++;
        //this._emitLeftZero();
        if (this._lastQueuesLength === 0 && this._queuesLength > 0) {
            var ref;
            (ref = this._store.heartbeat) != null ? typeof ref.ref === "function" ? ref.ref() : undefined : undefined;
        }
        this._lastQueuesLength = this._queuesLength;

        await this._drainAll();
        return reachedHWM;
    }

    // Helper to find and shift the last job from queues at or above a given priority
    _shiftLastFrom(priority) {
        for (let p = NUM_PRIORITIES - 1; p >= priority && p >= 0; p--) {
            if (this._queues[p].length > 0) {
                this._queuesLength--;
                //this._emitZero();
                if (this._lastQueuesLength > 0 && this._queuesLength === 0) {
                    var ref;
                    (ref = this._store.heartbeat) != null ? typeof ref.unref === "function" ? ref.unref() : undefined : undefined;
                }
                this._lastQueuesLength = this._queuesLength;
                return this._queues[p].pop();
            }
        }
        return undefined;
    }

    _receive(job) {
        if (this._states.jobStatus(job.options.id) != null) {
            job._reject(new Error(`A job with the same id already exists (id=${job.options.id})`));
            return false;
        } else {
            job.doReceive();
            return this._submitLock.schedule(this._addToQueue, job);
        }
    }

    chain(_limiter) {
        this._limiter = _limiter;
        return this;
    }

    schedule(...args) {
        var job, options, task;
        if (typeof args[0] === "function") {
            [task, ...args] = args;
            options = {};
        } else {
            [options, task, ...args] = args;
        }
        job = new Job(task, args, options, this.rejectOnDrop, this._states);
        this._receive(job);
        return job.promise;
    }

    wrap(fn) {
        var schedule, wrapped;
        schedule = this.schedule.bind(this);
        wrapped = function(...args) {
            return schedule(fn.bind(this), ...args);
        };
        wrapped.withOptions = function(options, ...args) {
            return schedule(options, fn, ...args);
        };
        return wrapped;
    }
}
