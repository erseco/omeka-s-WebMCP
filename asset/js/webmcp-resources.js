/**
 * WebMCP resource registration for Omeka-S admin interface.
 *
 * Exposes read-only data resources that AI agents can query for context
 * about the current Omeka-S instance. All data is fetched via the
 * server-side proxy at /admin/webmcp/proxy.
 *
 * @see https://webmachinelearning.github.io/webmcp/
 */

'use strict';

(function () {
    // Feature detection: only proceed if WebMCP API is available.
    if (
        typeof navigator === 'undefined' ||
        !navigator.modelContext ||
        typeof navigator.modelContext.registerResource !== 'function'
    ) {
        return;
    }

    const _proxyUrl = (window.WebMCPConfig && window.WebMCPConfig.proxy_url) || (function () {
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
     * @param {Object} payload  {op, resource, id?, query?, data?, ids?}
     * @returns {Promise<Object>}
     */
    async function proxyFetch(payload) {
        const response = await fetch(_proxyUrl, {
            method: 'POST',
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

    // =========================================================================
    // Resource: omeka-dashboard
    // URI: omeka://dashboard
    // Returns a JSON summary of the Omeka-S instance.
    // =========================================================================

    navigator.modelContext.registerResource({
        uri: 'omeka://dashboard',
        name: 'omeka-dashboard',
        description: 'Returns a JSON summary of the Omeka-S instance: total items, item sets, sites, users, and recent items.',
        read: async () => {
            try {
                // Fetch counts for all collections and recent items in parallel.
                // Each search response includes total_results in data.total_results.
                const [itemsRes, itemSetsRes, sitesRes, usersRes, recentRes] = await Promise.all([
                    proxyFetch({ op: 'search', resource: 'items',      query: { per_page: 1, page: 1 } }),
                    proxyFetch({ op: 'search', resource: 'item_sets',  query: { per_page: 1, page: 1 } }),
                    proxyFetch({ op: 'search', resource: 'sites',      query: { per_page: 1, page: 1 } }),
                    proxyFetch({ op: 'search', resource: 'users',      query: { per_page: 1, page: 1 } }),
                    proxyFetch({ op: 'search', resource: 'items',      query: { per_page: 5, sort_by: 'created', sort_order: 'desc' } }),
                ]);

                return {
                    total_items:     itemsRes.data?.total_results    ?? 0,
                    total_item_sets: itemSetsRes.data?.total_results  ?? 0,
                    total_sites:     sitesRes.data?.total_results     ?? 0,
                    total_users:     usersRes.data?.total_results     ?? 0,
                    recent_items:    recentRes.data?.items            ?? [],
                };
            } catch (err) {
                return { error: true, message: err.message };
            }
        },
    });

    // =========================================================================
    // Resource: omeka-item
    // URI template: omeka://items/{id}
    // Returns full JSON-LD representation of a specific item.
    // =========================================================================

    navigator.modelContext.registerResource({
        uriTemplate: 'omeka://items/{id}',
        name: 'omeka-item',
        description: 'Returns the full JSON-LD representation of a specific Omeka-S item.',
        read: async ({ id }) => {
            try {
                const result = await proxyFetch({ op: 'get', resource: 'items', id: parseInt(id, 10) });
                if (result.error) return result;
                return result.data;
            } catch (err) {
                return { error: true, message: err.message };
            }
        },
    });

    // =========================================================================
    // Resource: omeka-site-navigation
    // URI template: omeka://sites/{id}/navigation
    // Returns the navigation structure of a site.
    // =========================================================================

    navigator.modelContext.registerResource({
        uriTemplate: 'omeka://sites/{id}/navigation',
        name: 'omeka-site-navigation',
        description: 'Returns the navigation structure of an Omeka-S site.',
        read: async ({ id }) => {
            try {
                const result = await proxyFetch({ op: 'get', resource: 'sites', id: parseInt(id, 10) });
                if (result.error) return result;
                return {
                    site_id:    id,
                    navigation: result.data['o:navigation'] || [],
                };
            } catch (err) {
                return { error: true, message: err.message };
            }
        },
    });

    // =========================================================================
    // Resource: omeka-api-info
    // URI: omeka://api-info
    // Returns available API endpoints and the current user's permissions/role.
    // =========================================================================

    navigator.modelContext.registerResource({
        uri: 'omeka://api-info',
        name: 'omeka-api-info',
        description: 'Returns the current user\'s role and permissions. IMPORTANT: read this resource first before attempting any write operation to confirm the current user has sufficient privileges. Omeka-S role hierarchy: global_admin (everything), site_admin (manage sites + content), editor (create/edit/delete content + item sets), reviewer (edit content, cannot delete), author (create own content only), researcher (read-only).',
        read: async () => {
            try {
                // Resolve the current user ID from the admin-user link injected
                // into every admin page, then fetch via the proxy.
                let currentUser = null;
                let currentRole = null;
                const userLink = document.querySelector('#user-bar a[href*="/admin/user/"]');
                if (userLink) {
                    const match = userLink.getAttribute('href').match(/\/user\/(\d+)/);
                    if (match) {
                        const userResult = await proxyFetch({
                            op: 'get',
                            resource: 'users',
                            id: parseInt(match[1], 10),
                        }).catch(() => null);
                        if (userResult && !userResult.error) {
                            currentUser = userResult.data;
                            currentRole = currentUser ? (currentUser['o:role'] || null) : null;
                        }
                    }
                }

                // Fall back to role already resolved by webmcp.js DOMContentLoaded handler.
                if (!currentRole && window.WebMCPConfig && window.WebMCPConfig.currentRole) {
                    currentRole = window.WebMCPConfig.currentRole;
                }

                return {
                    current_role: currentRole,
                    permission_summary: {
                        can_manage_users:      currentRole === 'global_admin',
                        can_manage_sites:      currentRole === 'global_admin' || currentRole === 'site_admin',
                        can_create_item_sets:  ['global_admin', 'site_admin', 'editor'].includes(currentRole),
                        can_create_items:      ['global_admin', 'site_admin', 'editor'].includes(currentRole),
                        can_read_items:        currentRole !== null,
                    },
                    current_user: currentUser,
                };
            } catch (err) {
                return { error: true, message: err.message };
            }
        },
    });
})();
