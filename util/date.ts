export function today() {
	return new Date(new Date().setHours(0, 0, 0, 0));
}

export function nDaysAgo(n) {
	return new Date(today().setDate(today().getDate() - n));
}

export function isWeekday(day = today()) {
	return day.getDay() < 5;
}

export function yesterday() {
	return nDaysAgo(1);
}

export function tomorrow() {
	return nDaysAgo(-1);
}

export function nMonthsAgo(n) {
	return new Date(today().setMonth(today().getMonth() - n));
}

export function nYearsAgo(n) {
	return new Date(today().setFullYear(today().getFullYear() - n));
}

export function monthToDateByDays(callback, ...args) {
	const results = [];

	// WARN: Does not `setHours()`
	for (let origin = new Date(new Date().getFullYear(), new Date().getMonth(), 1), index = new Date(new Date(origin).setDate(origin.getDate() + 1)); index <= new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1); origin.setDate(origin.getDate() + 1), index.setDate(index.getDate() + 1)) {
		results.push(callback(origin, index, ...args));
	}

	return results;
}

export function getQuarter(date = new Date()) {
	return Math.ceil((date.getMonth() + 1) / 3);
}

export function last6MonthsToDateByMonths(callback, ...args) {
	const results = [];

	// WARN: Does not `setHours()`
	for (let origin = new Date(new Date().setMonth(new Date().getMonth() - 5)), index = new Date(new Date(origin).setMonth(origin.getMonth() + 1)); index <= new Date(new Date().getFullYear(), new Date().getMonth() + 2); origin.setMonth(origin.getMonth() + 1), index.setMonth(index.getMonth() + 1)) {
		results.push(callback(origin, index, ...args));
	}

	return results;
}

export function lastYearRolling45ByDays(callback, ...args) {
	const results = [];

	for (let origin = new Date(new Date(new Date().setFullYear(new Date().getFullYear() - 1)).setHours(0, 0, 0, 0)), index = new Date(new Date(origin).setDate(origin.getDate() + 45)); new Date(index).setDate(index.getDate() + 1) < Date.now(); origin.setDate(origin.getDate() + 1), index.setDate(index.getDate() + 1)) {
		results.push(callback(origin, index, ...args));
	}

	return results;
}

export function last2YearsByQuarters(callback, ...args) {
	const results = [];

	for (let origin = new Date(new Date(new Date().getFullYear() - 2, (getQuarter(new Date()) * 3) - 3).setHours(0, 0, 0, 0)), index = new Date(new Date(origin).setMonth(origin.getMonth() + 3)); index < new Date(new Date().getFullYear(), (getQuarter(new Date()) * 3) + 3); origin.setMonth(origin.getMonth() + 3), index.setMonth(index.getMonth() + 3)) {
		results.push(callback(origin, index, ...args));
	}

	return results;
}
