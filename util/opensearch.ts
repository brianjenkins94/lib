import { Client } from '@opensearch-project/opensearch';
import { nDaysAgo, today } from '../util/date';

export async function _search(client: Client, { index = undefined, aggs = undefined, range = undefined, filters = undefined, query = {}, scroll = undefined, size = undefined, sort = undefined, search_after = undefined, ...options } = {}) {
    range ??= {
        "@timestamp": {
            "gte": nDaysAgo(90).toISOString(),
            "lte": new Date(today().setMinutes(0, 0, -1)).toISOString()
        }
    };

    const { should = [], must = [], must_not = [], ...fields } = filters;

    filters = {
        "filter": [
            ...Object.entries(fields).map(function([key, value]) {
                return {
                    "bool": {
                        "should": [
                            {
                                "match_phrase": {
                                    [key]: value
                                }
                            }
                        ],
                        "minimum_should_match": 1
                    }
                };
            }),
            ...Object.entries(query).map(function([key, value]) {
                return {
                    "match_phrase": {
                        [key]: value
                    }
                };
            }),
            {
                "range": range
            }
        ],
        "should": should,
        "must": must,
        "must_not": must_not
    };

    const response = await client.search({
        "index": index,
        "body": {
            "aggs": aggs,
            "query": {
                "bool": filters
            },
            "search_after": search_after,
            "size": aggs !== undefined ? 0 : size,
            "sort": sort
        },
        "scroll": scroll
    });

    const aggregations = response.body.aggregations?.["composite_terms"] ?? response.body.aggregations;

    if (aggregations !== undefined) {
        console.log(`Received ${(aggregations["buckets"] && aggregations["buckets"].length) || response.body.hits.hits.length} buckets in ${(response.body["took"] / 1000).toFixed(3)}s.`);
    }

    return {
        "response": response,
        "body": response["body"],
        "hits": response["body"]["hits"]["hits"]
    };
}

// Returns all of the unique values for each field.
export async function getUniqueFieldValues(client: Client, { index, range = undefined, filter = undefined, fields = undefined, size = 1000 }) {
    const TERMS_LIMIT = 10000;

    const filters = {
        //"filter": filters,
        "should": [],
        "must": [],
        "must_not": []
    };

    fields = Object.fromEntries(fields.flatMap(function(fields) {
        if (typeof fields === "object") {
            return Object.entries(fields).flatMap(function([key, value]) {
                if (Array.isArray(value)) {
                    filters["must"].push(...Object.entries(fields).map(function([field, value]) {
                        return {
                            "terms": {
                                [field + ".keyword"]: value
                            }
                        };
                    }));

                    return [];
                } else if (typeof value === "object") {
                    if (Object.keys(value).some((key) => key.startsWith("gt") || key.startsWith("lt"))) {
                        filters["must"].push({
                            "range": {
                                [key]: value
                            }
                        });

                        return [];
                    }

                    throw new Error("Not yet implemented.");
                } else if (typeof value === "string") {
                    filters["must"].push(...Object.entries(fields).map(function([field, value]) {
                        return {
                            "term": {
                                [field + ".keyword"]: value
                            }
                        };
                    }));

                    return [];
                }

                filters["must"].push({
                    "term": {
                        [key + ".keyword"]: value
                    }
                });

                return [
                    [key, {
                        "terms": {
                            "field": key + ".keyword",
                            "order": { "_key": "asc" },
                            "size": TERMS_LIMIT
                        }
                    }]
                ];
            });
        }

        return [
            [fields, {
                "terms": {
                    "field": fields + ".keyword",
                    "order": { "_key": "asc" },
                    "size": TERMS_LIMIT
                }
            }]
        ];
    }));

    const { "body": { aggregations } } = await _search(client, {
        "index": index,
        "aggs": {
            ...fields,
        },
        "filters": filters,
        "range": range && {
            "@timestamp": range
        }
    });

    // Return early if there's only one field and it's under the limit
    if (Object.keys(fields).length === 1) {
        if (aggregations[Object.keys(fields)[0]]?.["buckets"] === undefined) {
            return aggregations[Object.keys(fields)[0]];
        }

        const { buckets } = aggregations[Object.keys(fields)[0]];

        if (buckets.length < TERMS_LIMIT) {
            return {
                [Object.keys(fields)[0]]: Object.fromEntries(buckets.map(({ key, doc_count  }) => [key, doc_count]))
            };
        }
    }

    // TODO: Replace with `mapEntries()`
    const results = await Promise.all(Object.keys(fields).map(async function(field) {
        let { buckets } = aggregations[field];

        const values = [];

        let afterKey;

        do {
            const { body } = await _search(client, {
                "index": index,
                "aggs": {
                    "composite_terms": {
                        //"filter": filter,
                        "composite": {
                            "size": size,
                            "sources": [
                                {
                                    [field]: {
                                        "terms": {
                                            "field": field + ".keyword",
                                            "order": "asc"
                                        }
                                    }
                                }
                            ],
                            ...(afterKey ? { "after": afterKey } : {})
                        }
                    }
                },
                "filters": filters,
                "range": range && {
                    "@timestamp": range
                },
                "size": size
            });

            ({ "aggregations": { "composite_terms": { buckets, "after_key": afterKey } } } = body);

            values.push(...buckets.map(({ "key": { [field]: key }, doc_count }) => [key, doc_count]));
        } while (afterKey !== undefined);

        return [field, Object.fromEntries(values)];
    }));

    return Object.fromEntries(results);
}

// Returns the results that match ALL fields
export async function getUniqueFieldCombinations(client: Client, { index, range = undefined, filter = undefined, fields = undefined, size = 1000 }) {
    const results = [];

    let afterKey;

    do {
        let buckets;

        const filters = {
            //"filter": filters,
            "should": [],
            "must": [],
            "must_not": []
        };

        const { body } = await _search(client, {
            "index": index,
            "aggs": {
                "composite_terms": {
                    //"filter": filter,
                    "composite": {
                        "size": size,
                        "sources": fields.map(function recurse(fields) {
                            if (typeof fields === "object") {
                                filters["must"].push(...Object.entries(fields).map(function([field, value]) {
                                    if (typeof value === "object") {
                                        if (Object.keys(value).some((key) => key.startsWith("gt") || key.startsWith("lt"))) {
                                            return {
                                                "range": {
                                                    [field]: value
                                                }
                                            };
                                        }

                                        throw new Error("Not yet implemented.")
                                    }

                                    return {
                                        "term": {
                                            [field + ".keyword"]: value
                                        }
                                    }
                                }));

                                return Object.keys(fields).map((key) => recurse(key));
                            }

                            return {
                                [fields]: {
                                    "terms": {
                                        "field": fields + ".keyword",
                                        "order": "asc"
                                    }
                                }
                            };
                        }).flat(),
                        ...(afterKey ? { "after": afterKey } : {})
                    }
                }
            },
            "filters": filters,
            "range": range && {
                "@timestamp": range
            }
        });

        ({ "aggregations": { "composite_terms": { buckets, "after_key": afterKey } } } = body);

        results.push(...buckets.map(({ key, doc_count }) => ({ ...key, doc_count })));
    } while (afterKey !== undefined);

    return results;
}

export async function scrollSearch(client: Client, { index = undefined, aggs = undefined, range = undefined, filters = undefined, query = undefined, scroll = "1m", size = 10000, ...options } = {}) {
    let { "body": { "_scroll_id": scrollId, "hits": { hits } } } = await _search(client, {
        index,
        aggs,
        range,
        filters,
        query,
        "scroll": scroll,
        "size": size,
        ...options
    });

    const results = [...hits];

    while (hits.length > 0) {
        const response = await client.transport.request({
            "method": "POST",
            "path": "/_search/scroll",
            "body": {
                "scroll": scroll,
                "scroll_id": scrollId
            }
        });

        ({ "body": { "_scroll_id": scrollId, "hits": { hits } } } = response);

        console.log(`Received ${Object.values(response.body?.aggregations ?? {}).reduce((count, { buckets }) => count + buckets.length, 0) || response.body.hits.hits.length} buckets in ${(response.body["took"] / 1000).toFixed(3)}s.`);

        results.push(...hits);
    }

    return results;
}

export async function poll(client: Client, { index = undefined, filters = undefined, query = undefined }) {
    let lastSort;

    async function tick() {
        const range = lastSort ? undefined : {
            "@timestamp": { "gte": "now-5m" }
        };

        const { hits } = await _search(client, {
            "index": index,
            "range": range,
            filters,
            query,
            "sort": [
                { "@timestamp": "asc" },
                { "_id": "asc" }
            ],
            "search_after": lastSort
        });

        for (const hit of hits) {
            console.log(hit);

            // Record sort values for search_after
            if (hit.sort?.length === 2) {
                lastSort = [hit.sort[0], hit.sort[1]];
            }
        }

        setTimeout(tick, 5000);
    }

    tick();
}
