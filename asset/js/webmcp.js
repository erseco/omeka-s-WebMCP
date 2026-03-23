/**
 * WebMCP tool registration for Omeka-S admin interface.
 *
 * Registers tools via navigator.modelContext.registerTool() so that AI agents
 * (browser extensions, built-in browser agents) can discover and invoke them.
 *
 * All operations are routed through the server-side proxy at
 * /admin/webmcp/proxy, which uses Omeka\ApiManager internally and therefore
 * runs inside Omeka-S's own request lifecycle. This bypasses any JWT
 * middleware that would block direct /api/* calls.
 *
 * @see https://webmachinelearning.github.io/webmcp/
 */

'use strict';

(function () {
    // Feature detection: only proceed if WebMCP API is available.
    if (
        typeof navigator === 'undefined' ||
        !navigator.modelContext ||
        typeof navigator.modelContext.registerTool !== 'function'
    ) {
        return;
    }

    // Runtime config injected by PHP (tool-group flags, CSRF token, proxy URL).
    const config           = window.WebMCPConfig || {};
    const groupItems       = config.items        === true;
    const groupMedia       = config.media        === true;
    const groupItemSets    = config.item_sets    === true;
    const groupSites       = config.sites        === true;
    const groupUsers       = config.users        === true;
    const groupVocabs      = config.vocabularies === true;
    const groupBulk        = config.bulk         === true;
    const _proxyUrl        = config.proxy_url    || (function () {
        // Fallback: derive admin base from current location to support subdirectory deployments.
        try {
            var idx = window.location.pathname.indexOf('/admin/');
            if (idx !== -1) return window.location.pathname.substring(0, idx) + '/admin/webmcp/proxy';
        } catch (e) {}
        return '/admin/webmcp/proxy';
    }());

    /**
     * Retrieve the CSRF token injected by PHP into window.WebMCPConfig.
     *
     * @returns {string}
     */
    function getCsrfToken() {
        return (window.WebMCPConfig && window.WebMCPConfig.csrf_token) || '';
    }

    /**
     * POST a payload to the server-side proxy and return the parsed response.
     *
     * The proxy wraps results in {success:true, data:...} or {error:true, message:...}.
     * This function returns the full wrapper object — callers should check
     * result.error before using result.data.
     *
     * @param {Object} payload  {op, resource, id?, query?, data?, ids?}
     * @returns {Promise<Object>}
     */
    async function proxyFetch(payload) {
        const response = await fetch(_proxyUrl, {
            method: 'POST',
            // 'include' (not 'same-origin') is required because the WebMCP
            // extension calls execute callbacks from an isolated context whose
            // origin is chrome-extension://, not the page origin.
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': getCsrfToken(),
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const text = await response.text();
            let message = `Proxy error ${response.status}`;
            try {
                const json = JSON.parse(text);
                message = json.message || message;
                if (json.details) message += `: ${json.details}`;
            } catch (_) { /* keep generic message */ }
            throw new Error(message);
        }
        return response.json();
    }

    /**
     * Structured error response returned by tool execute callbacks on failure.
     *
     * @param {Error|string} err
     * @returns {{error: boolean, message: string}}
     */
    function errorResult(err) {
        return { error: true, message: err instanceof Error ? err.message : String(err) };
    }

    // -------------------------------------------------------------------------
    // Role-awareness: detect the current user's role via the proxy so the AI
    // can skip privileged operations it would not be permitted to run.
    // -------------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', function () {
        const userLink = document.querySelector('#user-bar a[href*="/admin/user/"]');
        if (!userLink) return;
        const match = userLink.getAttribute('href').match(/\/user\/(\d+)/);
        if (!match) return;
        proxyFetch({ op: 'get', resource: 'users', id: parseInt(match[1], 10) })
            .then((result) => {
                if (!result.error && result.data && result.data['o:role']) {
                    window.WebMCPConfig = window.WebMCPConfig || {};
                    window.WebMCPConfig.currentRole = result.data['o:role'];
                }
            })
            .catch(() => {});
    });

    // =========================================================================
    // Item / Resource Management Tools
    // =========================================================================

    /**
     * Build an Omeka-S JSON-LD literal value array from a plain string.
     *
     * property_id:'auto' tells Omeka's ValueHydrator to resolve the property
     * ID from the vocabulary term key (e.g. 'dcterms:title'). Without it,
     * Omeka silently ignores the value and items are created as [untitled].
     *
     * @param {string} value
     * @returns {Array}
     */
    function literal(value) {
        return [{ 'type': 'literal', '@value': value, 'property_id': 'auto' }];
    }

    /**
     * Ensure every value in a properties object has property_id set.
     *
     * When the AI passes properties in JSON-LD format via the `properties`
     * input field, those values may lack property_id. Omeka's ValueHydrator
     * silently ignores values without property_id, so we default to 'auto'.
     *
     * @param {Object} properties  JSON-LD property map from AI input.
     * @returns {Object}
     */
    function normalizeProperties(properties) {
        if (!properties || typeof properties !== 'object') return {};
        const result = {};
        for (const [term, values] of Object.entries(properties)) {
            if (Array.isArray(values)) {
                result[term] = values.map((v) => {
                    if (v && typeof v === 'object' && !v['property_id']) {
                        return Object.assign({ 'property_id': 'auto' }, v);
                    }
                    return v;
                });
            } else {
                result[term] = values;
            }
        }
        return result;
    }

    /**
     * Merge convenience fields (title, description) into an Omeka-S data object.
     *
     * The Omeka-S API requires property values in JSON-LD format:
     *   {"dcterms:title": [{"type": "literal", "@value": "My title", "property_id": "auto"}]}
     *
     * AI agents often pass plain strings instead. This helper maps them so items
     * are never created as [untitled].
     *
     * Existing JSON-LD values in `properties` always take precedence.
     *
     * @param {Object} input  Raw tool input from the AI agent.
     * @returns {Object}      Data object ready to send to the proxy.
     */
    function buildItemData(input) {
        const data = normalizeProperties(input.properties);
        if (input.title && !data['dcterms:title']) {
            data['dcterms:title'] = literal(input.title);
        }
        if (input.description && !data['dcterms:description']) {
            data['dcterms:description'] = literal(input.description);
        }
        return data;
    }

    if (groupItems) {
        navigator.modelContext.registerTool({
            name: 'create-item',
            description: 'Create a new item in Omeka-S. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Item title (mapped to dcterms:title).',
                    },
                    description: {
                        type: 'string',
                        description: 'Item description (mapped to dcterms:description).',
                    },
                    resource_template_id: {
                        type: 'integer',
                        description: 'Optional resource template ID.',
                    },
                    item_set_ids: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: 'Optional array of item set IDs.',
                    },
                    properties: {
                        type: 'object',
                        description: 'Additional properties in JSON-LD format, e.g. {"dcterms:subject": [{"type": "literal", "@value": "History"}]}. Use title/description fields for those common fields instead.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    const data = buildItemData(input);
                    if (input.resource_template_id) {
                        data['o:resource_template'] = { 'o:id': input.resource_template_id };
                    }
                    if (input.item_set_ids && input.item_set_ids.length) {
                        data['o:item_set'] = input.item_set_ids.map((id) => ({ 'o:id': id }));
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'items', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'update-item',
            description: 'Update an existing item in Omeka-S. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Item ID to update.' },
                    title: {
                        type: 'string',
                        description: 'New title (mapped to dcterms:title).',
                    },
                    description: {
                        type: 'string',
                        description: 'New description (mapped to dcterms:description).',
                    },
                    properties: {
                        type: 'object',
                        description: 'Additional properties in JSON-LD format.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'update',
                        resource: 'items',
                        id: input.id,
                        data: buildItemData(input),
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'delete-item',
            description: 'Delete an item from Omeka-S. Shows a confirmation dialog before deleting. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Item ID to delete.' },
                },
            },
            execute: async (input, client) => {
                try {
                    if (client && typeof client.requestUserInteraction === 'function') {
                        const confirmed = await client.requestUserInteraction({
                            type: 'confirm',
                            message: `Are you sure you want to delete item #${input.id}? This action cannot be undone.`,
                        });
                        if (!confirmed) {
                            return { cancelled: true, message: 'Deletion cancelled by user.' };
                        }
                    }
                    const result = await proxyFetch({ op: 'delete', resource: 'items', id: input.id });
                    if (result.error) return result;
                    return { success: true, message: `Item #${input.id} deleted.` };
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'search-items',
            description: 'Search for items in Omeka-S.',
            inputSchema: {
                type: 'object',
                properties: {
                    fulltext_search: { type: 'string', description: 'Full-text search query.' },
                    resource_template_id: { type: 'integer', description: 'Filter by resource template ID.' },
                    item_set_id: { type: 'integer', description: 'Filter by item set ID.' },
                    property: {
                        type: 'array',
                        description: 'Property filters.',
                        items: {
                            type: 'object',
                            properties: {
                                property: { type: 'string' },
                                type: { type: 'string' },
                                text: { type: 'string' },
                            },
                        },
                    },
                    per_page: { type: 'integer', default: 25, description: 'Results per page.' },
                    page: { type: 'integer', default: 1, description: 'Page number.' },
                },
            },
            execute: async (input) => {
                try {
                    const query = {};
                    if (input.fulltext_search)     query.fulltext_search     = input.fulltext_search;
                    if (input.resource_template_id) query.resource_template_id = input.resource_template_id;
                    if (input.item_set_id)          query.item_set_id          = input.item_set_id;
                    query.per_page = input.per_page || 25;
                    query.page     = input.page     || 1;
                    if (input.property && Array.isArray(input.property)) {
                        query.property = input.property;
                    }
                    const result = await proxyFetch({ op: 'search', resource: 'items', query });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'get-item',
            description: 'Get a single item by ID from Omeka-S.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Item ID.' },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({ op: 'get', resource: 'items', id: input.id });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'catalog-item',
            description: 'Set full catalog metadata on an existing Omeka-S item: Dublin Core fields (title, description, creator, subject, date, etc.), resource class (RDF type), and resource template. Use this to describe and classify an item. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id:          { type: 'integer', description: 'Item ID to catalog.' },
                    title:       { type: 'string',  description: 'dcterms:title — human-readable name.' },
                    description: { type: 'string',  description: 'dcterms:description — free-text description.' },
                    creator:     { type: 'string',  description: 'dcterms:creator — author or creator.' },
                    contributor: { type: 'string',  description: 'dcterms:contributor — additional contributor.' },
                    subject:     {
                        description: 'dcterms:subject — topic or keyword. Can be a string or an array of strings.',
                        oneOf: [
                            { type: 'string' },
                            { type: 'array', items: { type: 'string' } },
                        ],
                    },
                    date:        { type: 'string',  description: 'dcterms:date — creation or publication date (ISO 8601 recommended, e.g. "2024-03-15").' },
                    type:        { type: 'string',  description: 'dcterms:type — nature or genre (e.g. "Photograph", "Document", "Sound").' },
                    format:      { type: 'string',  description: 'dcterms:format — file format or physical medium (e.g. "image/jpeg", "oil on canvas").' },
                    identifier:  { type: 'string',  description: 'dcterms:identifier — catalogue number, ISBN, URI, or other unique ID.' },
                    language:    { type: 'string',  description: 'dcterms:language — language of the resource (e.g. "es", "en", "fr").' },
                    publisher:   { type: 'string',  description: 'dcterms:publisher — organization responsible for making the resource available.' },
                    rights:      { type: 'string',  description: 'dcterms:rights — rights statement or license (e.g. "CC BY 4.0").' },
                    source:      { type: 'string',  description: 'dcterms:source — the resource from which this item is derived.' },
                    relation:    { type: 'string',  description: 'dcterms:relation — a related resource.' },
                    coverage:    { type: 'string',  description: 'dcterms:coverage — spatial or temporal extent (e.g. "Madrid", "1939–1945").' },
                    resource_class: {
                        type: 'string',
                        description: 'RDF class term that classifies this item, e.g. "dctype:Image", "dctype:PhysicalObject", "foaf:Person", "schema:Place", "bibo:Document". Use list-resource-classes to browse available classes.',
                    },
                    resource_template_id: {
                        type: 'integer',
                        description: 'Resource template ID. Use list-resource-templates to browse available templates.',
                    },
                    properties: {
                        type: 'object',
                        description: 'Extra properties in JSON-LD format for vocabularies beyond Dublin Core, e.g. {"bibo:edition": [{"type": "literal", "@value": "2nd"}]}.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    // Start from any extra JSON-LD properties the caller supplied.
                    const data = normalizeProperties(input.properties || {});

                    // Map convenience fields to Dublin Core terms.
                    const dcMap = {
                        title:       'dcterms:title',
                        description: 'dcterms:description',
                        creator:     'dcterms:creator',
                        contributor: 'dcterms:contributor',
                        date:        'dcterms:date',
                        type:        'dcterms:type',
                        format:      'dcterms:format',
                        identifier:  'dcterms:identifier',
                        language:    'dcterms:language',
                        publisher:   'dcterms:publisher',
                        rights:      'dcterms:rights',
                        source:      'dcterms:source',
                        relation:    'dcterms:relation',
                        coverage:    'dcterms:coverage',
                    };
                    for (const [field, term] of Object.entries(dcMap)) {
                        if (input[field] && !data[term]) {
                            data[term] = literal(input[field]);
                        }
                    }

                    // subject can be a string or an array of strings.
                    if (input.subject && !data['dcterms:subject']) {
                        const subjects = Array.isArray(input.subject) ? input.subject : [input.subject];
                        data['dcterms:subject'] = subjects.map((s) => ({
                            'type': 'literal', '@value': s, 'property_id': 'auto',
                        }));
                    }

                    // Resource template.
                    if (input.resource_template_id) {
                        data['o:resource_template'] = { 'o:id': input.resource_template_id };
                    }

                    // Resource class: look up by vocabulary prefix + local name.
                    if (input.resource_class) {
                        const colonIdx = input.resource_class.indexOf(':');
                        if (colonIdx > -1) {
                            const prefix    = input.resource_class.slice(0, colonIdx);
                            const localName = input.resource_class.slice(colonIdx + 1);
                            const classResult = await proxyFetch({
                                op: 'search',
                                resource: 'resource_classes',
                                query: { vocabulary_prefix: prefix, local_name: localName },
                            });
                            if (
                                !classResult.error &&
                                classResult.data &&
                                classResult.data.items &&
                                classResult.data.items.length > 0
                            ) {
                                data['o:resource_class'] = { 'o:id': classResult.data.items[0]['o:id'] };
                            } else {
                                return { error: true, message: `Resource class "${input.resource_class}" not found. Use list-resource-classes to browse available classes.` };
                            }
                        }
                    }

                    const result = await proxyFetch({ op: 'update', resource: 'items', id: input.id, data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Media Management Tools
    // =========================================================================

    if (groupMedia) {
        navigator.modelContext.registerTool({
            name: 'upload-media',
            description: 'Upload media to an item in Omeka-S using an existing upload form.',
            inputSchema: {
                type: 'object',
                required: ['item_id'],
                properties: {
                    item_id: { type: 'integer', description: 'The item ID to attach the media to.' },
                },
            },
            execute: async (input) => {
                try {
                    // Navigate to the item edit page so the user can upload via the form.
                    // Derive the admin base from _proxyUrl to support subdirectory deployments.
                    var adminBase = '/admin';
                    try {
                        var proxyPath = new URL(_proxyUrl, window.location.href).pathname;
                        var adminIdx = proxyPath.indexOf('/admin/');
                        if (adminIdx !== -1) adminBase = proxyPath.substring(0, adminIdx + '/admin'.length);
                    } catch (e) {}
                    window.location.href = adminBase + '/item/' + input.item_id + '/edit#media';
                    return { success: true, message: `Navigated to item #${input.item_id} edit page for media upload.` };
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-media',
            description: 'List media for a specific item in Omeka-S.',
            inputSchema: {
                type: 'object',
                required: ['item_id'],
                properties: {
                    item_id: { type: 'integer', description: 'Item ID.' },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'search',
                        resource: 'media',
                        query: { item_id: input.item_id },
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-url',
            description: 'Attach media to an Omeka-S item by fetching it from a URL. Omeka-S downloads and stores the file locally. Use public image/audio/video/PDF URLs. Placeholder services like https://picsum.photos/800/600 (random photos) or https://pravatar.cc/300 (avatars) work perfectly. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'url'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    url: { type: 'string', description: 'Public URL of the media file to fetch (image, audio, video, PDF, etc.). Supports placeholder services: https://picsum.photos/800/600, https://pravatar.cc/300, etc.' },
                    title: { type: 'string', description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'url',
                        'o:item': { 'o:id': input.item_id },
                        'ingest_url': input.url,
                    };
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-html',
            description: 'Attach an HTML snippet as media to an Omeka-S item. The HTML is stored inline and rendered on the public site. Useful for formatted text, embedded maps, or any HTML content. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'html'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    html: { type: 'string', description: 'HTML content to store (e.g. "<p>Description</p>" or an embedded map iframe).' },
                    title: { type: 'string', description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'html',
                        'o:item': { 'o:id': input.item_id },
                        'html': input.html,
                    };
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-embed',
            description: 'Attach an oEmbed media (YouTube, Vimeo, SoundCloud, Flickr, Twitter/X, etc.) to an Omeka-S item. Pass the canonical URL of the content — Omeka fetches the embed code automatically. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'url'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    url: { type: 'string', description: 'oEmbed-compatible URL, e.g. https://vimeo.com/123456789 or https://soundcloud.com/artist/track.' },
                    title: { type: 'string', description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'oembed',
                        'o:item': { 'o:id': input.item_id },
                        'o:source': input.url,
                    };
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-youtube',
            description: 'Attach a YouTube video to an Omeka-S item. Accepts standard YouTube URLs (https://www.youtube.com/watch?v=ID or https://youtu.be/ID). Optionally set start/end times in seconds. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'url'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    url: { type: 'string', description: 'YouTube video URL, e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ or https://youtu.be/dQw4w9WgXcQ.' },
                    start: { type: 'integer', description: 'Optional start time in seconds.' },
                    end:   { type: 'integer', description: 'Optional end time in seconds.' },
                    title: { type: 'string',  description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'youtube',
                        'o:item': { 'o:id': input.item_id },
                        'o:source': input.url,
                    };
                    if (input.start != null) data['start'] = String(input.start);
                    if (input.end   != null) data['end']   = String(input.end);
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-iiif',
            description: 'Attach a IIIF Image API resource to an Omeka-S item. Provide the URL to the IIIF image info.json endpoint (e.g. https://iiif.example.org/image/1/info.json). Omeka fetches image metadata and generates a thumbnail. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'url'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    url: { type: 'string', description: 'IIIF Image API info.json URL, e.g. https://iiif.example.org/image/1/info.json.' },
                    title: { type: 'string', description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'iiif',
                        'o:item': { 'o:id': input.item_id },
                        'o:source': input.url,
                    };
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'add-media-iiif-presentation',
            description: 'Attach a IIIF Presentation manifest to an Omeka-S item. Provide the manifest URL (e.g. https://iiif.example.org/manifest.json). Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['item_id', 'url'],
                properties: {
                    item_id: { type: 'integer', description: 'ID of the item to attach the media to.' },
                    url: { type: 'string', description: 'IIIF Presentation manifest URL.' },
                    title: { type: 'string', description: 'Optional title for the media (mapped to dcterms:title).' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {
                        'o:ingester': 'iiif_presentation',
                        'o:item': { 'o:id': input.item_id },
                        'o:source': input.url,
                    };
                    if (input.title) {
                        data['dcterms:title'] = literal(input.title);
                    }
                    const result = await proxyFetch({ op: 'create', resource: 'media', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Item Set Management Tools
    // =========================================================================

    if (groupItemSets) {
        navigator.modelContext.registerTool({
            name: 'create-item-set',
            description: 'Create a new item set (collection) in Omeka-S. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Item set title (mapped to dcterms:title).',
                    },
                    description: {
                        type: 'string',
                        description: 'Item set description (mapped to dcterms:description).',
                    },
                    properties: {
                        type: 'object',
                        description: 'Additional properties in JSON-LD format.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'create',
                        resource: 'item_sets',
                        data: buildItemData(input),
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'update-item-set',
            description: 'Update an existing item set in Omeka-S. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Item set ID to update.' },
                    title: {
                        type: 'string',
                        description: 'New title (mapped to dcterms:title).',
                    },
                    description: {
                        type: 'string',
                        description: 'New description (mapped to dcterms:description).',
                    },
                    properties: {
                        type: 'object',
                        description: 'Additional properties in JSON-LD format.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'update',
                        resource: 'item_sets',
                        id: input.id,
                        data: buildItemData(input),
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'delete-item-set',
            description: 'Delete an item set from Omeka-S. Shows a confirmation dialog before deleting. Requires role: editor, site_admin, or global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Item set ID to delete.' },
                },
            },
            execute: async (input, client) => {
                try {
                    if (client && typeof client.requestUserInteraction === 'function') {
                        const confirmed = await client.requestUserInteraction({
                            type: 'confirm',
                            message: `Are you sure you want to delete item set #${input.id}? This action cannot be undone.`,
                        });
                        if (!confirmed) {
                            return { cancelled: true, message: 'Deletion cancelled by user.' };
                        }
                    }
                    const result = await proxyFetch({ op: 'delete', resource: 'item_sets', id: input.id });
                    if (result.error) return result;
                    return { success: true, message: `Item set #${input.id} deleted.` };
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-item-sets',
            description: 'List item sets (collections) in Omeka-S.',
            inputSchema: {
                type: 'object',
                properties: {
                    per_page: { type: 'integer', default: 25, description: 'Results per page.' },
                    page: { type: 'integer', default: 1, description: 'Page number.' },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'search',
                        resource: 'item_sets',
                        query: { per_page: input.per_page || 25, page: input.page || 1 },
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Site Management Tools
    // =========================================================================

    /**
     * Generate a URL-safe slug from a title, like WordPress does.
     *
     * Lowercases the string, replaces spaces and non-alphanumeric characters
     * with hyphens, collapses consecutive hyphens, and trims edge hyphens.
     *
     * @param {string} title
     * @returns {string}
     */
    function slugify(title) {
        return title
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')  // strip diacritics (é → e, ñ → n, etc.)
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    if (groupSites) {
        navigator.modelContext.registerTool({
            name: 'create-site',
            description: 'Create a new Omeka-S site. Requires role: global_admin.',
            inputSchema: {
                type: 'object',
                required: ['title'],
                properties: {
                    title: { type: 'string', description: 'Site title.' },
                    slug:  { type: 'string', description: 'Site URL slug (e.g. "my-site"). Auto-generated from title if omitted.' },
                    theme: { type: 'string', description: 'Theme name (optional).' },
                },
            },
            execute: async (input) => {
                try {
                    // Accept both plain keys (new schema) and o:-prefixed keys
                    // (old cached schema) so both browser-cached and fresh
                    // registrations work correctly.
                    const title = input.title || input['o:title'] || '';
                    const slug  = input.slug  || input['o:slug']  || slugify(title);
                    const data = {
                        'o:title': title,
                        'o:slug':  slug,
                        // Omeka-S requires a theme; default to 'default'.
                        'o:theme': input.theme || input['o:theme'] || 'default',
                    };
                    const result = await proxyFetch({ op: 'create', resource: 'sites', data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'update-site',
            description: 'Update an existing Omeka-S site. Requires role: global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id:    { type: 'integer', description: 'Site ID to update.' },
                    title: { type: 'string',  description: 'New title.' },
                    slug:  { type: 'string',  description: 'New URL slug.' },
                    theme: { type: 'string',  description: 'New theme name.' },
                },
            },
            execute: async (input) => {
                try {
                    const data = {};
                    const title = input.title || input['o:title'];
                    const slug  = input.slug  || input['o:slug'];
                    const theme = input.theme || input['o:theme'];
                    if (title) data['o:title'] = title;
                    if (slug)  data['o:slug']  = slug;
                    if (theme) data['o:theme'] = theme;
                    const result = await proxyFetch({ op: 'update', resource: 'sites', id: input.id, data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-sites',
            description: 'List all Omeka-S sites.',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const result = await proxyFetch({ op: 'search', resource: 'sites' });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // User Management Tools
    // =========================================================================

    if (groupUsers) {
        navigator.modelContext.registerTool({
            name: 'create-user',
            description: 'Create a new Omeka-S user. Requires role: global_admin.',
            inputSchema: {
                type: 'object',
                required: ['name', 'email', 'role'],
                properties: {
                    name:  { type: 'string', description: 'User display name.' },
                    email: { type: 'string', description: 'User email address.' },
                    role: {
                        type: 'string',
                        enum: ['global_admin', 'site_admin', 'editor', 'reviewer', 'author', 'researcher'],
                        description: 'User role.',
                    },
                },
            },
            execute: async (input) => {
                try {
                    // Accept both plain keys (new schema) and o:-prefixed keys
                    // (old cached schema). o:is_active must be true or the
                    // account cannot log in.
                    const result = await proxyFetch({
                        op: 'create',
                        resource: 'users',
                        data: {
                            'o:name':      input.name  || input['o:name'],
                            'o:email':     input.email || input['o:email'],
                            'o:role':      input.role  || input['o:role'],
                            'o:is_active': true,
                        },
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'update-user',
            description: 'Update an existing Omeka-S user. Requires role: global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id:    { type: 'integer', description: 'User ID to update.' },
                    name:  { type: 'string',  description: 'New display name.' },
                    email: { type: 'string',  description: 'New email address.' },
                    role: {
                        type: 'string',
                        enum: ['global_admin', 'site_admin', 'editor', 'reviewer', 'author', 'researcher'],
                    },
                },
            },
            execute: async (input) => {
                try {
                    const data = {};
                    const name  = input.name  || input['o:name'];
                    const email = input.email || input['o:email'];
                    const role  = input.role  || input['o:role'];
                    if (name)  data['o:name']  = name;
                    if (email) data['o:email'] = email;
                    if (role)  data['o:role']  = role;
                    const result = await proxyFetch({ op: 'update', resource: 'users', id: input.id, data });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'delete-user',
            description: 'Delete an Omeka-S user. Shows a confirmation dialog before deleting. Requires role: global_admin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'User ID to delete.' },
                },
            },
            execute: async (input, client) => {
                try {
                    if (client && typeof client.requestUserInteraction === 'function') {
                        const confirmed = await client.requestUserInteraction({
                            type: 'confirm',
                            message: `Are you sure you want to delete user #${input.id}? This action cannot be undone.`,
                        });
                        if (!confirmed) {
                            return { cancelled: true, message: 'Deletion cancelled by user.' };
                        }
                    }
                    const result = await proxyFetch({ op: 'delete', resource: 'users', id: input.id });
                    if (result.error) return result;
                    return { success: true, message: `User #${input.id} deleted.` };
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-users',
            description: 'List all Omeka-S users. Requires role: global_admin.',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const result = await proxyFetch({ op: 'search', resource: 'users' });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Vocabulary & Resource Template Tools
    // =========================================================================

    if (groupVocabs) {
        navigator.modelContext.registerTool({
            name: 'list-vocabularies',
            description: 'List available vocabularies (e.g. Dublin Core) in Omeka-S.',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const result = await proxyFetch({ op: 'search', resource: 'vocabularies' });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-resource-classes',
            description: 'List RDF resource classes available in Omeka-S (e.g. dctype:Image, foaf:Person, schema:Place). Use the returned term (prefix:LocalName) as the resource_class parameter of catalog-item.',
            inputSchema: {
                type: 'object',
                properties: {
                    vocabulary_prefix: {
                        type: 'string',
                        description: 'Filter by vocabulary prefix, e.g. "dctype", "foaf", "schema", "bibo".',
                    },
                },
            },
            execute: async (input) => {
                try {
                    const query = {};
                    if (input.vocabulary_prefix) query.vocabulary_prefix = input.vocabulary_prefix;
                    const result = await proxyFetch({ op: 'search', resource: 'resource_classes', query });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-properties',
            description: 'List properties belonging to a vocabulary in Omeka-S.',
            inputSchema: {
                type: 'object',
                required: ['vocabulary_id'],
                properties: {
                    vocabulary_id: { type: 'integer', description: 'Vocabulary ID.' },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'search',
                        resource: 'properties',
                        query: { vocabulary_id: input.vocabulary_id },
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'list-resource-templates',
            description: 'List resource templates available in Omeka-S.',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const result = await proxyFetch({ op: 'search', resource: 'resource_templates' });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'get-resource-template',
            description: 'Get a resource template by ID from Omeka-S.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer', description: 'Resource template ID.' },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({ op: 'get', resource: 'resource_templates', id: input.id });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Bulk Operation Tools
    // =========================================================================

    if (groupBulk) {
        navigator.modelContext.registerTool({
            name: 'batch-create-items',
            description: 'Create multiple items in Omeka-S in a single operation.',
            inputSchema: {
                type: 'object',
                required: ['items'],
                properties: {
                    items: {
                        type: 'array',
                        description: 'Array of item objects to create.',
                        items: { type: 'object' },
                    },
                },
            },
            execute: async (input) => {
                try {
                    const result = await proxyFetch({
                        op: 'batch_create',
                        resource: 'items',
                        data: input.items,
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });

        navigator.modelContext.registerTool({
            name: 'batch-delete-items',
            description: 'Delete multiple items from Omeka-S. Shows a confirmation dialog before deleting.',
            inputSchema: {
                type: 'object',
                required: ['ids'],
                properties: {
                    ids: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: 'Array of item IDs to delete.',
                    },
                },
            },
            execute: async (input, client) => {
                try {
                    if (client && typeof client.requestUserInteraction === 'function') {
                        const confirmed = await client.requestUserInteraction({
                            type: 'confirm',
                            message: `Are you sure you want to delete ${input.ids.length} item(s)? This action cannot be undone.`,
                        });
                        if (!confirmed) {
                            return { cancelled: true, message: 'Batch deletion cancelled by user.' };
                        }
                    }
                    const result = await proxyFetch({
                        op: 'batch_delete',
                        resource: 'items',
                        ids: input.ids,
                    });
                    if (result.error) return result;
                    return result.data;
                } catch (err) {
                    return errorResult(err);
                }
            },
        });
    }

    // =========================================================================
    // Declarative API: add WebMCP attributes to known Omeka-S admin forms
    // =========================================================================

    document.addEventListener('DOMContentLoaded', function () {
        /**
         * Add WebMCP declarative attributes to a form element.
         *
         * @param {HTMLFormElement} form
         * @param {string} toolname
         * @param {string} tooldescription
         * @param {boolean} autosubmit
         */
        function annotateForm(form, toolname, tooldescription, autosubmit) {
            if (!form) return;
            form.setAttribute('toolname', toolname);
            form.setAttribute('tooldescription', tooldescription);
            if (autosubmit) {
                form.setAttribute('toolautosubmit', 'true');
            }
        }

        // Item edit form
        const itemEditForm = document.querySelector('#item-form, form.resource-form[action*="/item/"]');
        annotateForm(
            itemEditForm,
            'edit-item-form',
            'Edit the current item\'s metadata and properties',
            true
        );

        // Item set edit form
        const itemSetEditForm = document.querySelector('#item-set-form, form.resource-form[action*="/item-set/"]');
        annotateForm(
            itemSetEditForm,
            'edit-item-set-form',
            'Edit the current item set\'s metadata and properties',
            true
        );

        // Site settings form
        const siteSettingsForm = document.querySelector('#site-settings, form[action*="/site/"]');
        annotateForm(
            siteSettingsForm,
            'edit-site-settings-form',
            'Edit the current site\'s settings',
            true
        );

        // User edit form
        const userEditForm = document.querySelector('#user-form, form[action*="/user/"]');
        annotateForm(
            userEditForm,
            'edit-user-form',
            'Edit the current user\'s profile and settings',
            true
        );

        // Admin sidebar search form
        const searchForm = document.querySelector('#search form, .search-form, form[action*="/admin/search"]');
        annotateForm(
            searchForm,
            'search-resources',
            'Search for items, item sets, or media in the Omeka-S catalog',
            false
        );
    });
})();
