export function map(promises, callback) {
	return Promise.all(promises.map(callback));
}

export function series(promises) {
	return promises.reduce(function(previous, next) {
		return previous.then(next);
	}, Promise.resolve());
}

export async function filter(array, callback) {
	const results = await Promise.all(array.map(function(object) {
		return callback(object);
	}));

	return array.filter(function(_, index) {
		return results[index];
	});
}
