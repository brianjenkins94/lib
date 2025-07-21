import { Client } from '@opensearch-project/opensearch';
import { nDaysAgo, today } from '../util/date';

export async function _search(client: Client, { index = undefined, aggs = undefined, range = undefined, filters = {}, query = [], scroll = undefined, size = undefined, ...options } = {}) {
    range ??= {
        "@timestamp": {
            "gte": nDaysAgo(90).toISOString(),
            "lte": new Date(today().setMinutes(0, 0, -1)).toISOString()
        }
    };

    filters = {
        "filter": [
            ...Object.entries(options).map(function([key, value]) {
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
        "should": filters["should"] ?? [],
        "must": filters["must"] ?? [],
        "must_not": filters["must_not"] ?? []
    };

    const response = await client.search({
        "index": index,
        "body": {
            "size": aggs !== undefined ? 0 : undefined,
            "aggs": aggs,
            "query": {
                "bool": filters
            }
        },
        "scroll": scroll,
        "size": size
    });

    const aggregations = response.body.aggregations?.["composite_terms"] ?? response.body.aggregations;

    console.log(`Received ${(aggregations["buckets"] && aggregations["buckets"].length) || response.body.hits.hits.length} buckets in ${(response.body["took"] / 1000).toFixed(3)}s.`);

    return {
        "response": response,
        "body": response["body"],
        "hits": response["body"]["hits"]["hits"]
    };
}

export async function getUniqueFieldValues(client: Client, { index, range = undefined, filter = undefined, fields = undefined, size = 1000 }) {
    const TERMS_LIMIT = 10000;

    const filters = {
        //"filter": filters,
        "should": [],
        "must": [],
        "must_not": []
    };

    fields = Object.fromEntries(fields.map(function recurse(fields) {
        if (typeof fields === "object") {
            return Object.entries(fields).map(function([key, value]) {
                if (typeof value === "string") {
                    filters["must"].push(...Object.entries(fields).map(function([field, value]) {
                        return {
                            "term": {
                                [field + ".keyword"]: value
                            }
                        }
                    }));

                    return;
                }

                return [key, value];
            }).filter(Boolean);
        }

        return [
            fields,
            {
                "terms": {
                    "field": fields + ".keyword",
                    "order": "asc",
                    "size": TERMS_LIMIT
                }
            }
        ];
    }).flat());

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

        const { buckets } = aggregations[fields[0]];

        if (buckets.length < TERMS_LIMIT) {
            return {
                [fields[0]]: buckets.map(({ key }) => key)
            };
        }
    }

    // TODO: Replace with `mapEntries()`
    const results = await Promise.all(fields.map(async function(field) {
        let { buckets } = aggregations[field];

        if (buckets.length !== TERMS_LIMIT) {
            return [field, buckets.map(({ key }) => key)];
        }

        const values = [];

        let afterKey;

        do {
            const { body } = await _search(client, {
                "index": index,
                "aggs": {
                    "composite_terms": {
                        "filter": filter,
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
                }
            });

            ({ "aggregations": { "composite_terms": { buckets, "after_key": afterKey } } } = body);

            values.push(...buckets.map(({ "key": { [field]: value } }) => value));
        } while (afterKey !== undefined);

        return [field, values];
    }));

    return Object.fromEntries(results);
}

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
                    "filter": filter,
                    "composite": {
                        "size": size,
                        "sources": fields.map(function recurse(fields) {
                            if (typeof fields === "object") {
                                filters["must"].push(...Object.entries(fields).map(function([field, value]) {
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
