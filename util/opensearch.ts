import { Client } from '@opensearch-project/opensearch';

export async function _search(client: Client, { index = undefined, aggs = undefined, range = undefined, filters = undefined, query = {}, scroll = undefined, size = undefined, sort = undefined, search_after = undefined, _source = undefined, filter_path = undefined, ...options } = {}) {
    range ??= {
        "@timestamp": {
            "gte": new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 90)).toISOString(),
            "lt": new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString(),
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
                                "term": {
                                    [key + ".keyword"]: value
                                },
                            },
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
        "_source": _source,
        "filter_path": filter_path,
        "body": {
            ...options,
            "aggs": aggs,
            "query": {
                "bool": filters
            },
            "search_after": search_after,
            "size": aggs !== undefined ? 0 : size,
            "sort": sort
        },
        "scroll": scroll,
        // Debug
        "allow_partial_search_results": false,
        "track_total_hits": true
    });

    const aggregations = response.body.aggregations?.["composite_terms"] ?? response.body.aggregations;
    const hits = response.body["hits"]?.["hits"] ?? [];

    if (aggregations !== undefined) {
        console.info(`Received ${(aggregations["buckets"] && aggregations["buckets"].length) || hits.length} buckets in ${(response.body["took"] / 1000).toFixed(3)}s.`);
    }

    return {
        "response": response,
        "body": response.body,
        "hits": hits
    };
}

function transformFields({ filters, fields }) {
    const TERMS_LIMIT = 10000;

    filters = {
        //"filter": filters,
        "should": [],
        "must": [],
        "must_not": []
    };

    fields = Object.fromEntries(fields.flatMap(function(field) {
        if (typeof field === "object") {
            return Object.entries(field).flatMap(function([key, value]) {
                if (Array.isArray(value)) {
                    filters["must"].push({
                        "bool": {
                            "should": [
                                {
                                    "terms": {
                                        [`${key}.keyword`]: value
                                    }
                                },
                                ...value.map(value => ({ "match_phrase": { [key]: value } }))
                            ],
                            "minimum_should_match": 1
                        }
                    });

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

                    return [
                        [key, value]
                    ];
                } else if (typeof value === "string") {
                    filters["must"].push(...Object.entries(field).map(function([key, value]) {
                        return {
                            "bool": {
                                "should": [
                                    {
                                        "term": {
                                            [key + ".keyword"]: value
                                        }
                                    },
                                    {
                                        "match_phrase": { [key]: value }
                                    }
                                ],
                                "minimum_should_match": 1
                            }
                        };
                    }));

                    return [];
                }

                filters["must"].push({
                    "bool": {
                        "should": [
                            {
                                "term": {
                                    [key + ".keyword"]: value
                                }
                            },
                            {
                                "match_phrase": { [key]: value }
                            }
                        ],
                        "minimum_should_match": 1
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
            [field, {
                "terms": {
                    "field": field + ".keyword",
                    "order": "asc", //{ "_key": "asc" },
                    //"size": TERMS_LIMIT
                }
            }]
        ];
    }));

    // <Claude>

    // Detect numeric fields from range filters and strip .keyword suffix
    const numericFields = new Set(
        filters["must"]
            .filter((f) => f.range)
            .flatMap((f) => Object.entries(f.range)
                .filter(([, v]) => Object.values(v).some((n) => typeof n === "number"))
                .map(([k]) => k)
            )
    );

    for (const [key, value] of Object.entries(fields)) {
        if (numericFields.has(key) && value?.terms?.field?.endsWith(".keyword")) {
            value.terms.field = key;
        }
    }

    // </Claude>

    return {
        "filters": filters,
        "fields": fields
    }
}

// Yields pages of [key, count] entries for a single field
async function* streamFieldBuckets(client: Client, { index, field, value, filters, range, size = 1000, ...options }) {
    let afterKey, buckets;

    do {
        const { body } = await _search(client, {
            ...options,
            "index": index,
            "aggs": {
                "composite_terms": {
                    //"filter": filter,
                    "composite": {
                        "size": size,
                        "sources": [
                            {
                                [field]: value
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

        yield Object.fromEntries(buckets.map(({ key: { [field]: k }, doc_count }) => [k, doc_count]));
  } while (afterKey !== undefined);
}

export async function* streamUniqueFieldValues(client: Client, { index, range = undefined, /* filters = undefined, filter = undefined, */ fields = undefined, size = 1000, ...options }) {
    let filters;

    ({ filters, fields } = transformFields({ filters, fields }));

    // For each field, yield tagged pages as they arrive
    for (const [field, value] of Object.entries(fields)) {
        for await (const page of streamFieldBuckets(client, {
            "index": index,
            "field": field,
            "value": value,
            "filters": filters,
            "range": range,
            "size": size,
            ...options
        })) {
            yield { field, page };
        }
    }
}

// Returns all of the unique values for each field.
export async function getUniqueFieldValues(client: Client, { index, range = undefined, /* filters = undefined, filter = undefined, */ fields = undefined, size = 1000, ...options }) {
    let filters;

    ({ filters, fields } = transformFields({ filters, fields }));

    // TODO: Replace with `mapEntries()`
    const results = await Promise.all(Object.entries(fields).map(async function([field, value]) {
        const accumulated: Record<string, number> = {};

        for await (const page of streamFieldBuckets(client, {
            "index": index,
            "field": field,
            "value": value,
            "filters": filters,
            "range": range,
            "size": size,
            ...options,
        })) {
            for (const key in page) {
                accumulated[key] = (accumulated[key] ?? 0) + page[key];
            }
        }

        return [field, accumulated];
    }));

    return Object.fromEntries(results);
}

// Returns the results that match ALL fields
export async function getUniqueFieldCombinations(client: Client, { index, range = undefined, /* filters = undefined, filter = undefined, */ fields = undefined, size = 1000, ...options }) {
    const results = [];

    let filters, afterKey;

    ({ filters, fields } = transformFields({ filters: undefined, fields }));

    // Convert transformFields output to composite sources format
    const sources = Object.entries(fields).map(([key, value]) => ({
        [key]: {
            "terms": {
                "field": value.terms.field, // Previously: key
                "order": "asc"
            }
        }
    }));

    do {
        let buckets;

        const { body } = await _search(client, {
            ...options,
            "index": index,
            "aggs": {
                "composite_terms": {
                    //"filter": filter,
                    "composite": {
                        "size": size,
                        "sources": sources,
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

export async function* streamSearch(client: Client, { index = undefined, range = undefined, /* filters = undefined, */ fields = undefined, size = 1000, ...options } = {}) {
    let filters;

    ({ filters, fields } = transformFields({ filters, fields }));

    const sort = [{ "@timestamp": "asc" }];

    let search_after;

    do {
        const { body, hits } = await _search(client, {
            ...options,
            "index": index,
            "filters": filters,
            "range": range && {
                "@timestamp": range
            },
            "sort": sort,
            "search_after": search_after,
            "_source": Object.keys(fields),
            "filter_path": ["took", "hits.hits.sort", ...Object.keys(fields).map((field) => "hits.hits._source." + field)],
            "size": size
        });

        if (hits.length === 0) {
            break;
        }

        console.info(`Received ${hits.length} buckets in ${(body["took"] / 1000).toFixed(3)}s.`);

        yield hits;

        search_after = hits.at(-1).sort;
    } while (true);
}

export async function* streamScrollSearch(client: Client, { index = undefined, range = undefined, /* filters = undefined, */ fields = undefined, scroll = "2m", size = 1000, ...options } = {}) {
    let filters;

    ({ filters, fields } = transformFields({ filters, fields }));

    // Preflight

    const preflight = await _search(client, {
        ...options,
        "index": index,
        "filters": filters,
        "range": range && {
            "@timestamp": range
        },
        "size": 1
    });

    if (preflight.body["hits"]["hits"].length === 0) {
        return;
    }

    let { "body": { "_scroll_id": scrollId, "took": took }, hits } = await _search(client, {
        ...options,
        "index": index,
        "filters": filters,
        "range": range && {
            "@timestamp": range
        },
        "sort": [
            { "_doc": 'asc' }
        ],
        "_source": Object.keys(fields),
        "filter_path": ["_scroll_id", "took", ...Object.keys(fields).map((field) => "hits.hits._source." + field)],
        "scroll": scroll,
        "size": size
    });

    if (hits.length > 0) {
        console.info(`Received ${hits.length} buckets in ${(took / 1000).toFixed(3)}s.`);

        yield hits;
    }

    while (hits.length > 0) {
        const response = await client.transport.request({
            "method": "POST",
            "path": "/_search/scroll",
            "querystring": 'filter_path=_scroll_id,took,' + Object.keys(fields).map((field) => "hits.hits._source." + field).join(","),
            "body": {
                "scroll": scroll,
                "scroll_id": scrollId
            }
        });

        scrollId = response.body["_scroll_id"];
        hits = response.body["hits"]?.["hits"] ?? [];

        console.info(`Received ${Object.values(response.body?.aggregations ?? {}).reduce((count, { buckets }) => count + buckets.length, 0) || hits.length} buckets in ${(response.body["took"] / 1000).toFixed(3)}s.`);

        if (hits.length > 0) {
            yield hits;
        }
    }

    try {
        await client.transport.request({
            "method": 'DELETE',
            "path": '/_search/scroll',
            "body": {
                "scroll_id": scrollId
            }
        });
    } catch (error) {
        console.warn(error["name"] + ": " + error["message"]);
    }
}

export async function scrollSearch(client: Client, { index = undefined, range = undefined, /* filters = undefined, */ fields = undefined, scroll = "2m", size = 1000, ...options } = {}) {
    const results = [];

    for await (const hits of streamScrollSearch(client, {
        index,
        range,
        /* filters = undefined, */
        fields,
        scroll,
        size,
        ...options
    })) {
        results.push(...hits);
    }

    return results;
}

export async function poll(client: Client, { index = undefined, /* filters = undefined, */ ...options }) {
    let lastSort;

    async function tick() {
        const range = lastSort ? undefined : {
            "@timestamp": { "gte": "now-5m" }
        };

        const { hits } = await _search(client, {
            ...options,
            "index": index,
            //"filters": filters,
            "range": range,
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
