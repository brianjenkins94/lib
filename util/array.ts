export function partition(promises, callback) {
	return promises.reduce(function(result, element, index) {
		if (callback(element, index, promises)) {
			result[0].push(element);
		} else {
			result[1].push(element);
		}

		return result;
	}, [[], []]);
}

export function mapAsync(promises, callback) {
	return Promise.all(promises.map(callback));
}

export async function filterAsync(promises, callback) {
	const results = await mapAsync(promises, function(element) {
		return callback(element);
	});

	return promises.filter(function(_, index) {
		return results[index];
	});
}

export function series(promises) {
	return promises.reduce(function(previous, next) {
		return previous.then(next);
	}, Promise.resolve());
}
