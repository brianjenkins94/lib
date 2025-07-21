export class EventEmitter {
	private events = {};

	public on(event, listener) {
		this.events[event] ??= [];

		this.events[event].push(listener);

		return () => this.off(event, listener);
	}

	public off(event?, listener?) {
		if (event === undefined && listener === undefined) {
			this.events = {};
		} else if (listener === undefined) {
			delete this.events[event];
		} else if (this.events[event].indexOf(listener) !== -1) {
			this.events[event].splice(this.events[event].indexOf(listener), 1);
		}
	}

	public emit(event, ...args) {
		const listeners = [...(this.events[event] ?? []), ...(this.events["*"] ?? [])];

		return Promise.allSettled(listeners.map(fn => fn(...args)));
	}

	public once(event, listener) {
		const off = this.on(event, (...args: any[]) => {
			off();
			listener(...args);
		});

		return off;
	}
}
