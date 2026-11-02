/*
 * User Ratings - jellyfin-web integration.
 *
 * Injected into index.html by the plugin. Adds:
 *  - a ratings panel on item detail pages,
 *  - a "User Ratings" tab on the home screen listing every rated item.
 *
 * Everything is driven by one idempotent sync() that runs on navigation and on
 * (throttled) DOM changes, so there is no polling and no page reloads.
 */
(function () {
    'use strict';

    if (window.__userRatingsLoaded) {
        return;
    }
    window.__userRatingsLoaded = true;

    const MAX_NOTE_LENGTH = 2000; // Keep in sync with RatingsController.MaxNoteLength
    const PAGE_SIZE = 24;
    const TAB_CONTENT_ID = 'userRatingsTab';
    const STAR_LABELS = ['', 'Awful', 'Meh', 'Good', 'Great', 'Masterpiece'];
    const TYPE_FILTERS = [['', 'All'], ['Movie', 'Movies'], ['Series', 'Shows'], ['Episode', 'Episodes']];
    const RECENT_SECTIONS = [
        ['Movie', 'Recently rated movies'],
        ['Series', 'Recently rated shows'],
        ['Episode', 'Recently rated episodes']
    ];
    // Comparators use the precomputed `title` / `time` keys set in attachItemDetails.
    const collator = new Intl.Collator();
    const SORTS = {
        'rating-desc': ['Rating: high to low', (a, b) => b.AverageRating - a.AverageRating],
        'rating-asc': ['Rating: low to high', (a, b) => a.AverageRating - b.AverageRating],
        'title-asc': ['Title: A-Z', (a, b) => collator.compare(a.title, b.title)],
        'title-desc': ['Title: Z-A', (a, b) => collator.compare(b.title, a.title)],
        'recent': ['Recently rated', (a, b) => b.time - a.time],
        'oldest': ['Oldest rated', (a, b) => a.time - b.time],
        'count-desc': ['Most ratings', (a, b) => b.TotalRatings - a.TotalRatings],
        'count-asc': ['Fewest ratings', (a, b) => a.TotalRatings - b.TotalRatings]
    };

    injectStyles();

    // ---------------------------------------------------------------- helpers

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function normalizeId(id) {
        return String(id).replace(/-/g, '').toLowerCase();
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function formatDate(timestamp) {
        return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    const relativeFormat = typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
        : null;
    const RELATIVE_UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

    function formatRelative(timestamp) {
        if (!relativeFormat) {
            return formatDate(timestamp);
        }
        const seconds = (new Date(timestamp) - Date.now()) / 1000;
        for (const [unit, size] of RELATIVE_UNITS) {
            if (Math.abs(seconds) >= size) {
                return relativeFormat.format(Math.round(seconds / size), unit);
            }
        }
        return 'just now';
    }

    function hashRoute() {
        return window.location.hash.split('?')[0];
    }

    function hashParams() {
        return new URLSearchParams(window.location.hash.split('?')[1] || '');
    }

    async function api(method, path, body) {
        const headers = { 'X-Emby-Token': ApiClient.accessToken() };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(ApiClient.getUrl(path), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text.replace(/^"|"$/g, '') || `${response.status} ${response.statusText}`);
        }

        return response.status === 204 ? null : response.json();
    }

    /** Read-only star display; supports fractional values (e.g. averages). */
    function starMeter(value, className) {
        const meter = el('span', 'ur-meter' + (className ? ' ' + className : ''));
        meter.setAttribute('role', 'img');
        meter.setAttribute('aria-label', `${value.toFixed(1)} out of 5`);
        meter.style.setProperty('--ur-fill', `${(value / 5) * 100}%`);
        return meter;
    }

    function avatar(name) {
        const node = el('span', 'ur-avatar', (name.trim()[0] || '?').toUpperCase());
        let hue = 0;
        for (const c of name) {
            hue = (hue * 31 + c.charCodeAt(0)) % 360;
        }
        node.style.setProperty('--ur-hue', hue);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }

    // ------------------------------------------------------ item detail panel

    function syncDetailPage() {
        if (!hashRoute().startsWith('#/details')) {
            return;
        }

        const itemId = hashParams().get('id');
        // Jellyfin keeps previously visited views in the DOM, hidden: only touch the visible one.
        const page = document.querySelector('.itemDetailPage:not(.hide)');
        if (!itemId || !page) {
            return;
        }

        // Sit next to the detail section rather than inside it: on recent Jellyfin it's a flex row
        // whose width is shared with the overview, which squashes the panel.
        const section = page.querySelector('.detailPagePrimaryContent .detailSection');
        const target = section?.parentElement
            || page.querySelector('.detailPagePrimaryContent')
            || page.querySelector('.detailPageContent');
        if (!target) {
            return;
        }

        const existing = page.querySelector('.user-ratings-container');
        if (existing) {
            if (existing.dataset.itemId === itemId && existing.isConnected) {
                return;
            }
            existing.remove();
        }

        const container = el('section', 'user-ratings-container ur-root');
        container.dataset.itemId = itemId;
        if (section) {
            section.after(container);
        } else {
            target.appendChild(container);
        }
        renderDetail(container, itemId);
    }

    async function renderDetail(container, itemId, flash) {
        if (!container.firstChild) {
            container.appendChild(el('div', 'ur-muted', 'Loading ratings…'));
        }

        let data;
        try {
            data = await api('GET', `UserRatings/Items/${itemId}`);
        } catch (error) {
            console.error('[UserRatings] Could not load ratings', error);
            container.replaceChildren(el('div', 'ur-muted', `Could not load ratings: ${error.message}`));
            return;
        }

        if (container.isConnected) {
            container.replaceChildren(...buildDetail(container, itemId, data, flash));
        }
    }

    function buildDetail(container, itemId, data, flash) {
        const parts = [el('h2', 'ur-heading', 'User Ratings')];

        const layout = el('div', 'ur-layout');
        layout.appendChild(buildSummary(data));
        layout.appendChild(buildForm(container, itemId, data.MyRating, flash));
        parts.push(layout);

        if (data.Ratings.length > 0) {
            parts.push(buildReviews(data.Ratings, data.MyRating));
        }

        return parts;
    }

    function buildSummary(data) {
        const summary = el('div', 'ur-card ur-summary');
        const total = data.TotalRatings;

        if (total === 0) {
            summary.classList.add('ur-summary-empty');
            summary.appendChild(el('div', 'ur-empty-star', '★'));
            summary.appendChild(el('div', 'ur-card-title', 'No ratings yet'));
            summary.appendChild(el('div', 'ur-muted', 'Be the first to rate it.'));
            return summary;
        }

        const head = el('div', 'ur-summary-head');
        head.appendChild(el('div', 'ur-score', data.AverageRating.toFixed(1)));
        const meta = el('div', 'ur-summary-meta');
        meta.appendChild(starMeter(data.AverageRating));
        meta.appendChild(el('span', 'ur-muted', plural(total, 'rating')));
        head.appendChild(meta);
        summary.appendChild(head);

        const counts = [0, 0, 0, 0, 0, 0];
        for (const rating of data.Ratings) {
            counts[rating.Rating]++;
        }

        const bars = el('div', 'ur-bars');
        for (let stars = 5; stars >= 1; stars--) {
            const row = el('div', 'ur-bar-row');
            row.appendChild(el('span', 'ur-bar-label', `${stars} ★`));
            const track = el('div', 'ur-bar');
            const fill = el('div', 'ur-bar-fill');
            fill.style.width = `${(counts[stars] / total) * 100}%`;
            track.appendChild(fill);
            row.appendChild(track);
            row.appendChild(el('span', 'ur-bar-count', String(counts[stars])));
            bars.appendChild(row);
        }
        summary.appendChild(bars);

        return summary;
    }

    function buildForm(container, itemId, myRating, flash) {
        let selected = myRating ? myRating.Rating : 0;

        const form = el('div', 'ur-card ur-form');
        form.appendChild(el('div', 'ur-card-title', myRating ? 'Your rating' : 'Rate this'));

        const starsRow = el('div', 'ur-stars-row');
        const label = el('span', 'ur-star-label');
        const showLabel = (value) => {
            label.textContent = value ? STAR_LABELS[value] : 'Tap a star';
            label.classList.toggle('ur-active', !!value);
        };
        starsRow.appendChild(buildStarInput(selected, {
            onPreview: showLabel,
            onSelect: (value) => {
                selected = value;
                setStatus('');
            }
        }));
        starsRow.appendChild(label);
        showLabel(selected);
        form.appendChild(starsRow);

        const note = el('textarea', 'ur-note');
        note.placeholder = 'What did you think? (optional)';
        note.maxLength = MAX_NOTE_LENGTH;
        note.rows = 3;
        note.value = myRating?.Note || '';
        note.setAttribute('aria-label', 'Note');
        form.appendChild(note);

        const footer = el('div', 'ur-form-footer');
        const counter = el('span', 'ur-counter');
        const updateCounter = () => {
            counter.textContent = `${note.value.length} / ${MAX_NOTE_LENGTH}`;
        };
        note.addEventListener('input', updateCounter);
        updateCounter();
        footer.appendChild(counter);

        const actions = el('div', 'ur-actions');
        const deleteButton = el('button', 'ur-button ur-button-ghost', 'Delete');
        deleteButton.type = 'button';
        deleteButton.hidden = !myRating;
        actions.appendChild(deleteButton);

        const saveButton = el('button', 'ur-button ur-button-primary', myRating ? 'Update' : 'Post rating');
        saveButton.type = 'button';
        actions.appendChild(saveButton);
        footer.appendChild(actions);
        form.appendChild(footer);

        const status = el('div', 'ur-status');
        status.setAttribute('role', 'status');
        form.appendChild(status);

        function setStatus(message, kind) {
            status.textContent = message;
            status.classList.toggle('ur-error', kind === 'error');
            status.classList.toggle('ur-success', kind === 'success');
        }

        if (flash) {
            setStatus(flash, 'success');
        }

        saveButton.addEventListener('click', async () => {
            if (!selected) {
                setStatus('Pick a number of stars first.', 'error');
                return;
            }

            saveButton.disabled = true;
            setStatus('Saving…');
            try {
                await api('POST', `UserRatings/Items/${itemId}`, { Rating: selected, Note: note.value });
                await renderDetail(container, itemId, 'Rating saved.');
            } catch (error) {
                setStatus(`Could not save: ${error.message}`, 'error');
                saveButton.disabled = false;
            }
        });

        deleteButton.addEventListener('click', async () => {
            if (!window.confirm('Delete your rating?')) {
                return;
            }

            deleteButton.disabled = true;
            setStatus('Deleting…');
            try {
                await api('DELETE', `UserRatings/Items/${itemId}`);
                await renderDetail(container, itemId, 'Rating deleted.');
            } catch (error) {
                setStatus(`Could not delete: ${error.message}`, 'error');
                deleteButton.disabled = false;
            }
        });

        return form;
    }

    function buildStarInput(initial, { onPreview, onSelect }) {
        const wrapper = el('div', 'ur-stars');
        wrapper.setAttribute('role', 'group');
        wrapper.setAttribute('aria-label', 'Your rating');

        let value = initial;
        const buttons = [];
        const paint = (count) => {
            buttons.forEach((button, i) => button.classList.toggle('ur-filled', i < count));
            onPreview(count);
        };

        for (let i = 1; i <= 5; i++) {
            const button = el('button', 'ur-star', '★');
            button.type = 'button';
            button.setAttribute('aria-label', `${plural(i, 'star')} – ${STAR_LABELS[i]}`);
            button.addEventListener('mouseenter', () => paint(i));
            button.addEventListener('click', () => {
                value = i;
                paint(i);
                onSelect(i);
            });
            buttons.push(button);
            wrapper.appendChild(button);
        }

        wrapper.addEventListener('mouseleave', () => paint(value));
        buttons.forEach((button, i) => button.classList.toggle('ur-filled', i < value));
        return wrapper;
    }

    function buildReviews(ratings, myRating) {
        const isMine = (rating) => !!myRating && rating.UserId === myRating.UserId;

        const section = el('div', 'ur-reviews');
        const title = el('h3', 'ur-subheading', 'Reviews');
        title.appendChild(el('span', 'ur-pill', String(ratings.length)));
        section.appendChild(title);

        const grid = el('div', 'ur-review-grid');
        // Own review first, then newest first (server order).
        const sorted = [...ratings].sort((a, b) => isMine(b) - isMine(a));
        for (const rating of sorted) {
            grid.appendChild(buildReview(rating, isMine(rating)));
        }
        section.appendChild(grid);

        return section;
    }

    function buildReview(rating, isMine) {
        const card = el('article', 'ur-review' + (isMine ? ' ur-review-mine' : ''));

        const head = el('div', 'ur-review-head');
        head.appendChild(avatar(rating.UserName));

        const meta = el('div', 'ur-review-meta');
        const name = el('div', 'ur-review-name');
        name.appendChild(el('span', 'ur-ellipsis', rating.UserName));
        if (isMine) {
            name.appendChild(el('span', 'ur-tag', 'You'));
        }
        meta.appendChild(name);

        const sub = el('div', 'ur-review-sub');
        sub.appendChild(starMeter(rating.Rating, 'ur-meter-sm'));
        const time = el('time', 'ur-muted', formatRelative(rating.Timestamp));
        time.dateTime = rating.Timestamp;
        time.title = formatDate(rating.Timestamp);
        sub.appendChild(time);
        meta.appendChild(sub);

        head.appendChild(meta);
        card.appendChild(head);

        if (rating.Note) {
            card.appendChild(el('p', 'ur-review-note', rating.Note));
        }

        return card;
    }

    // --------------------------------------------------------- home page tab

    // Tab content / button we deactivated when opening ours, restored on close.
    let hiddenTabContent = null;
    let hiddenTabButton = null;
    let browser = null; // { items, sort, type, page }

    function syncHomeTab() {
        if (!hashRoute().startsWith('#/home')) {
            return;
        }

        const slider = document.querySelector('.headerTabs .emby-tabs-slider');
        if (!slider || !slider.querySelector('.emby-tab-button') || slider.querySelector('[data-ratings-tab]')) {
            return;
        }

        const button = el('button', 'emby-tab-button emby-button');
        button.type = 'button';
        button.dataset.ratingsTab = 'true';
        button.appendChild(el('div', 'emby-button-foreground', 'User Ratings'));
        button.addEventListener('click', (e) => {
            // Keep emby-tabs from handling a tab it doesn't know about.
            e.preventDefault();
            e.stopPropagation();
            openRatingsTab(button, slider);
        });
        slider.appendChild(button);

        if (!slider.dataset.ratingsListener) {
            slider.dataset.ratingsListener = 'true';
            // Capture phase: restore the native tab before emby-tabs processes the click.
            slider.addEventListener('click', (e) => {
                const target = e.target.closest('.emby-tab-button');
                if (target && !target.dataset.ratingsTab) {
                    closeRatingsTab();
                }
            }, true);
        }
    }

    function openRatingsTab(button, slider) {
        const home = document.querySelector('.homePage:not(.hide)');
        if (!home) {
            return;
        }

        let content = document.getElementById(TAB_CONTENT_ID);
        if (!content) {
            content = el('div', 'tabContent pageTabContent');
            content.id = TAB_CONTENT_ID;
            content.addEventListener('change', onBrowserChange);
            content.addEventListener('click', onBrowserClick);
            // 'error' doesn't bubble: capture it to drop broken posters and reveal the fallback.
            content.addEventListener('error', (e) => {
                if (e.target.tagName === 'IMG') {
                    e.target.remove();
                }
            }, true);
        }

        if (!content.classList.contains('is-active')) {
            const activeContent = home.querySelector('.pageTabContent.is-active');
            const activeButton = slider.querySelector('.emby-tab-button-active');
            (activeContent?.parentNode || home).appendChild(content);

            if (activeContent) {
                activeContent.classList.remove('is-active');
                hiddenTabContent = activeContent;
            }
            if (activeButton && activeButton !== button) {
                activeButton.classList.remove('emby-tab-button-active');
                hiddenTabButton = activeButton;
            }

            button.classList.add('emby-tab-button-active');
            content.classList.add('is-active');
        }

        loadRatingsBrowser(content);
    }

    function closeRatingsTab() {
        const content = document.getElementById(TAB_CONTENT_ID);
        if (!content || !content.classList.contains('is-active')) {
            return;
        }

        content.classList.remove('is-active');
        document.querySelector('[data-ratings-tab]')?.classList.remove('emby-tab-button-active');
        hiddenTabContent?.classList.add('is-active');
        hiddenTabButton?.classList.add('emby-tab-button-active');
        hiddenTabContent = null;
        hiddenTabButton = null;
    }

    async function loadRatingsBrowser(content) {
        content.innerHTML = '<div class="ur-root ur-browser"><div class="ur-empty">Loading ratings…</div></div>';

        try {
            const summary = await api('GET', 'UserRatings/Items');
            const items = await attachItemDetails(summary.Items);

            if (items.length === 0) {
                content.innerHTML = '<div class="ur-root ur-browser"><div class="ur-empty">'
                    + '<div class="ur-empty-star">★</div><div class="ur-card-title">No rated items yet</div>'
                    + '<div class="ur-muted">Open any movie or show and rate it to see it here.</div></div></div>';
                return;
            }

            browser = { items, sort: browser?.sort || 'rating-desc', type: '', page: 1 };
            content.innerHTML = '<div class="ur-root ur-browser">'
                + buildBrowserHeader(items)
                + buildRecentSections(items, summary.RecentlyRatedItemsCount)
                + '<section class="ur-section ur-all-items"></section></div>';
            renderAllItems(content);
        } catch (error) {
            console.error('[UserRatings] Could not load rated items', error);
            content.innerHTML = `<div class="ur-root ur-browser"><div class="ur-empty ur-error">Could not load ratings: ${escapeHtml(error.message)}</div></div>`;
        }
    }

    /**
     * Fetches item details in batches. Items the user can't access (or that were
     * deleted) are not returned by Jellyfin and are dropped.
     */
    async function attachItemDetails(summaries) {
        const userId = ApiClient.getCurrentUserId();
        const batches = [];
        for (let i = 0; i < summaries.length; i += 100) {
            // Only what the cards need: no user data, no total count.
            batches.push(ApiClient.getItems(userId, {
                Ids: summaries.slice(i, i + 100).map((s) => s.ItemId).join(','),
                EnableImageTypes: 'Primary',
                ImageTypeLimit: 1,
                EnableUserData: false,
                EnableTotalRecordCount: false
            }));
        }

        const details = new Map();
        for (const result of await Promise.all(batches)) {
            for (const item of result.Items || []) {
                details.set(normalizeId(item.Id), item);
            }
        }

        return summaries
            .filter((s) => details.has(normalizeId(s.ItemId)))
            .map((s) => {
                const d = details.get(normalizeId(s.ItemId));
                return { ...s, details: d, title: cardTitle(d), time: Date.parse(s.LastRated) };
            });
    }

    function buildBrowserHeader(items) {
        const totalRatings = items.reduce((sum, item) => sum + item.TotalRatings, 0);
        const average = items.reduce((sum, item) => sum + item.AverageRating * item.TotalRatings, 0) / totalRatings;
        const stat = (value, label) => `<div class="ur-stat"><div class="ur-stat-value">${value}</div><div class="ur-stat-label">${label}</div></div>`;

        return `
            <header class="ur-hero">
                <h1 class="ur-hero-title">User Ratings</h1>
                <div class="ur-stats">
                    ${stat(items.length, 'Titles')}
                    ${stat(totalRatings, 'Ratings')}
                    ${stat(`<span class="ur-gold">★</span> ${average.toFixed(1)}`, 'Average')}
                </div>
            </header>`;
    }

    function buildRecentSections(items, limit) {
        return RECENT_SECTIONS.map(([type, title]) => {
            const recent = items
                .filter((item) => item.details.Type === type)
                .sort(SORTS.recent[1])
                .slice(0, limit);
            if (recent.length === 0) {
                return '';
            }
            return `
                <section class="ur-section">
                    <div class="ur-section-head"><h2 class="ur-section-title">${escapeHtml(title)}</h2></div>
                    <div class="ur-row">${buildCards(recent)}</div>
                </section>`;
        }).join('');
    }

    function renderAllItems(content) {
        const container = content.querySelector('.ur-all-items');
        if (!container || !browser) {
            return;
        }

        const { items, sort, type } = browser;
        const filtered = type ? items.filter((item) => item.details.Type === type) : items;
        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        browser.page = Math.min(Math.max(1, browser.page), totalPages);

        const start = (browser.page - 1) * PAGE_SIZE;
        const pageItems = [...filtered].sort(SORTS[sort][1]).slice(start, start + PAGE_SIZE);

        const presentTypes = new Set(items.map((item) => item.details.Type));
        const chips = TYPE_FILTERS
            .filter(([value]) => !value || presentTypes.has(value))
            .map(([value, label]) => `<button type="button" class="ur-chip${value === type ? ' ur-chip-active' : ''}" data-type="${value}" aria-pressed="${value === type}">${label}</button>`)
            .join('');

        const options = Object.entries(SORTS)
            .map(([value, [label]]) => `<option value="${value}"${value === sort ? ' selected' : ''}>${label}</option>`)
            .join('');

        const pager = totalPages <= 1 ? '' : `
            <nav class="ur-pager" aria-label="Pages">
                <button type="button" class="ur-page-btn" data-page="-1" aria-label="Previous page" ${browser.page === 1 ? 'disabled' : ''}>‹</button>
                <span class="ur-muted">Page ${browser.page} of ${totalPages}</span>
                <button type="button" class="ur-page-btn" data-page="1" aria-label="Next page" ${browser.page === totalPages ? 'disabled' : ''}>›</button>
            </nav>`;

        container.innerHTML = `
            <div class="ur-section-head">
                <h2 class="ur-section-title">All rated</h2>
                <span class="ur-muted">${plural(filtered.length, 'title')}</span>
            </div>
            <div class="ur-toolbar">
                <div class="ur-chips" role="group" aria-label="Filter by type">${chips}</div>
                <label class="ur-sort-label">
                    <span class="ur-muted">Sort by</span>
                    <select class="ur-select ur-sort">${options}</select>
                </label>
            </div>
            <div class="ur-grid">${buildCards(pageItems)}</div>
            ${pager}`;
    }

    function onBrowserChange(e) {
        if (e.target.classList.contains('ur-sort') && browser) {
            browser.sort = e.target.value;
            browser.page = 1;
            renderAllItems(e.currentTarget);
        }
    }

    function onBrowserClick(e) {
        if (!browser) {
            return;
        }

        const content = e.currentTarget;
        const chip = e.target.closest('[data-type]');
        if (chip) {
            browser.type = chip.dataset.type;
            browser.page = 1;
            renderAllItems(content);
            return;
        }

        const pageButton = e.target.closest('[data-page]');
        if (pageButton && !pageButton.disabled) {
            browser.page += Number(pageButton.dataset.page);
            renderAllItems(content);
            content.querySelector('.ur-all-items')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Episodes are shown with their series poster, so lead with the series name.
    function cardTitle(details) {
        return (details.Type === 'Episode' ? details.SeriesName : details.Name) || details.Name || '';
    }

    function cardSubtitle(details) {
        if (details.Type === 'Episode') {
            const code = details.ParentIndexNumber != null && details.IndexNumber != null
                ? `S${details.ParentIndexNumber}:E${details.IndexNumber} · `
                : '';
            return code + (details.Name || '');
        }
        return details.ProductionYear ? String(details.ProductionYear) : '';
    }

    function buildCards(items) {
        const serverId = ApiClient.serverId();
        return items.map((item) => {
            const d = item.details;
            const href = `#/details?id=${encodeURIComponent(d.Id)}&serverId=${encodeURIComponent(serverId)}`;
            const title = item.title;
            const image = imageUrl(d);
            // Fallback letter sits under the image; shows if there is no image or it fails to load.
            const poster = `<span class="ur-poster-fallback">${escapeHtml(title.trim()[0] || '?')}</span>`
                + (image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">` : '');

            return `
                <a class="ur-poster-card" href="${href}" title="${escapeHtml(title)}">
                    <div class="ur-poster">
                        ${poster}
                        <span class="ur-badge">
                            <span class="ur-gold">★</span>${item.AverageRating.toFixed(1)}
                            <span class="ur-badge-count">(${item.TotalRatings})</span>
                        </span>
                    </div>
                    <div class="ur-poster-title">${escapeHtml(title)}</div>
                    <div class="ur-poster-sub">${escapeHtml(cardSubtitle(d)) || '&nbsp;'}</div>
                </a>`;
        }).join('');
    }

    function imageUrl(details) {
        // Episodes use the series poster so the grid stays portrait.
        const useSeries = details.Type === 'Episode' && details.SeriesId && details.SeriesPrimaryImageTag;
        const id = useSeries ? details.SeriesId : details.Id;
        const tag = useSeries ? details.SeriesPrimaryImageTag : details.ImageTags?.Primary;
        return tag ? ApiClient.getImageUrl(id, { type: 'Primary', tag, maxHeight: 450, quality: 90 }) : null;
    }

    // ------------------------------------------------------------- wiring

    function sync() {
        if (!window.ApiClient || !ApiClient.accessToken()) {
            return;
        }
        syncDetailPage();
        syncHomeTab();
    }

    // Throttled rather than debounced: a page that mutates constantly must not starve sync().
    let syncTimer = null;
    function scheduleSync() {
        if (syncTimer) {
            return;
        }
        syncTimer = setTimeout(() => {
            syncTimer = null;
            sync();
        }, 150);
    }

    window.addEventListener('hashchange', () => {
        closeRatingsTab();
        scheduleSync();
    });
    // jellyfin-web dispatches a bubbling "viewshow" on each page it displays.
    document.addEventListener('viewshow', scheduleSync);
    // Detail pages and header tabs render asynchronously after viewshow.
    new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
    scheduleSync();

    // ------------------------------------------------------------- styles

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .ur-root {
                --ur-accent: #00a4dc;
                --ur-gold: #ffc83d;
                --ur-surface: rgba(18, 18, 24, 0.55);
                --ur-surface-2: rgba(255, 255, 255, 0.08);
                --ur-border: rgba(255, 255, 255, 0.1);
                --ur-muted: rgba(255, 255, 255, 0.6);
                --ur-radius: 12px;
            }
            .ur-root *, .ur-root *::before, .ur-root *::after { box-sizing: border-box; }
            .ur-muted { color: var(--ur-muted); }
            .ur-gold { color: var(--ur-gold); }
            .ur-error { color: #ff6b6b !important; }
            .ur-success { color: #5ccf7f !important; }
            .ur-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

            /* Shared bits */
            .ur-card {
                background: var(--ur-surface);
                border: 1px solid var(--ur-border);
                border-radius: var(--ur-radius);
                padding: 1.25em 1.4em;
                min-width: 0;
                -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
            }
            .ur-card-title { font-weight: 600; font-size: 1.05em; margin-bottom: 0.7em; }
            .ur-meter {
                position: relative; display: inline-block; line-height: 1; white-space: nowrap;
                font-size: 1.15em; letter-spacing: 0.08em; color: rgba(255, 255, 255, 0.18);
            }
            .ur-meter::before { content: '★★★★★'; }
            .ur-meter::after {
                content: '★★★★★'; position: absolute; left: 0; top: 0;
                width: var(--ur-fill, 0%); overflow: hidden; color: var(--ur-gold);
            }
            .ur-meter-sm { font-size: 0.9em; }
            .ur-empty-star { font-size: 2.6em; line-height: 1; color: var(--ur-gold); opacity: 0.35; margin-bottom: 0.2em; }
            .ur-button {
                font: inherit; font-size: 0.9em; font-weight: 600; letter-spacing: 0.02em;
                padding: 0.6em 1.5em; border-radius: 999px; border: 1px solid transparent;
                cursor: pointer; transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
            }
            .ur-button:disabled { opacity: 0.5; cursor: default; }
            .ur-button:focus-visible { outline: 2px solid var(--ur-accent); outline-offset: 2px; }
            .ur-button-primary { background: var(--ur-accent); color: #fff; }
            .ur-button-primary:hover:not(:disabled) { background: #0091c4; }
            .ur-button-ghost { background: transparent; color: inherit; border-color: var(--ur-border); }
            .ur-button-ghost:hover:not(:disabled) { background: var(--ur-surface-2); }

            /* Detail page panel */
            .user-ratings-container { display: block; width: 100%; max-width: 1400px; flex: 1 1 100%; grid-column: 1 / -1; align-self: stretch; margin: 2.5em 0 1.5em; container-type: inline-size; }
            .ur-heading { font-size: 1.4em; font-weight: 600; margin: 0 0 0.8em; }
            .ur-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1em; align-items: stretch; }
            @container (min-width: 720px) {
                .ur-layout { grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); }
            }
            .ur-summary-head { display: flex; align-items: center; gap: 0.8em; margin-bottom: 1.1em; }
            .ur-score { font-size: 3em; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
            .ur-summary-meta { display: flex; flex-direction: column; gap: 0.4em; font-size: 0.95em; }
            .ur-summary-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
            .ur-summary-empty .ur-card-title { margin-bottom: 0.2em; }
            .ur-bars { display: grid; gap: 0.45em; }
            .ur-bar-row { display: grid; grid-template-columns: 2.4em 1fr 1.8em; align-items: center; gap: 0.6em; font-size: 0.85em; }
            .ur-bar-label { color: var(--ur-muted); white-space: nowrap; }
            .ur-bar { height: 0.5em; border-radius: 999px; background: var(--ur-surface-2); overflow: hidden; }
            .ur-bar-fill { height: 100%; border-radius: inherit; background: var(--ur-gold); }
            .ur-bar-count { text-align: right; color: var(--ur-muted); font-variant-numeric: tabular-nums; }

            .ur-stars-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3em 0.9em; margin-bottom: 0.8em; }
            .ur-stars { display: inline-flex; }
            .ur-star {
                appearance: none; background: none; border: 0; margin: 0; padding: 0.05em 0.08em;
                font-size: 2.1em; line-height: 1; cursor: pointer; color: rgba(255, 255, 255, 0.18);
                transition: color 0.12s, transform 0.12s; -webkit-tap-highlight-color: transparent;
            }
            .ur-star.ur-filled { color: var(--ur-gold); }
            .ur-star:hover { transform: scale(1.12); }
            .ur-star:focus-visible { outline: 2px solid var(--ur-accent); outline-offset: 2px; border-radius: 4px; }
            .ur-star-label { font-weight: 500; color: var(--ur-muted); }
            .ur-star-label.ur-active { color: var(--ur-gold); }
            .ur-note {
                display: block; width: 100%; min-height: 5.5em; resize: vertical;
                padding: 0.75em 0.9em; font: inherit; line-height: 1.5; color: inherit;
                background: rgba(0, 0, 0, 0.25); border: 1px solid var(--ur-border); border-radius: 8px;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .ur-note::placeholder { color: rgba(255, 255, 255, 0.35); }
            .ur-note:focus { outline: none; border-color: var(--ur-accent); box-shadow: 0 0 0 3px rgba(0, 164, 220, 0.25); }
            .ur-form-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75em; margin-top: 0.8em; }
            .ur-counter { font-size: 0.8em; color: var(--ur-muted); font-variant-numeric: tabular-nums; }
            .ur-actions { display: flex; gap: 0.6em; margin-left: auto; }
            .ur-status { font-size: 0.9em; color: var(--ur-muted); margin-top: 0.6em; }
            .ur-status:empty { display: none; }

            .ur-reviews { margin-top: 1.8em; }
            .ur-subheading { display: flex; align-items: center; gap: 0.5em; font-size: 1.15em; font-weight: 600; margin: 0 0 0.8em; }
            .ur-pill { font-size: 0.75em; font-weight: 500; padding: 0.15em 0.65em; border-radius: 999px; background: var(--ur-surface-2); color: var(--ur-muted); }
            .ur-review-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 0.8em; }
            .ur-review { background: var(--ur-surface); border: 1px solid var(--ur-border); border-radius: var(--ur-radius); padding: 1em 1.1em; min-width: 0; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
            .ur-review-mine { border-color: rgba(0, 164, 220, 0.5); background: rgba(0, 164, 220, 0.06); }
            .ur-review-head { display: flex; align-items: center; gap: 0.75em; }
            .ur-avatar {
                flex: none; width: 2.4em; height: 2.4em; border-radius: 50%;
                display: grid; place-items: center; font-weight: 700; color: #fff;
                background: hsl(var(--ur-hue, 200), 45%, 36%);
            }
            .ur-review-meta { min-width: 0; }
            .ur-review-name { display: flex; align-items: center; gap: 0.5em; font-weight: 600; min-width: 0; }
            .ur-tag {
                flex: none; font-size: 0.68em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
                padding: 0.2em 0.5em; border-radius: 4px; background: rgba(0, 164, 220, 0.2); color: #6fd0f2;
            }
            .ur-review-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3em 0.6em; margin-top: 0.3em; font-size: 0.85em; }
            .ur-review-note { margin: 0.75em 0 0; line-height: 1.55; color: rgba(255, 255, 255, 0.85); white-space: pre-wrap; overflow-wrap: anywhere; }

            /* Home tab browser */
            .ur-browser { padding: 1.5em clamp(1em, 3.5vw, 3.3em) 3em; }
            .ur-empty { padding: 4em 1em; text-align: center; font-size: 1.05em; color: var(--ur-muted); }
            .ur-empty .ur-card-title { color: #fff; }
            .ur-hero { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1em 2em; }
            .ur-hero-title { margin: 0; font-size: clamp(1.6em, 4vw, 2.3em); font-weight: 700; letter-spacing: -0.01em; }
            .ur-stats { display: flex; flex-wrap: wrap; gap: 0.6em; }
            .ur-stat { min-width: 6.5em; padding: 0.55em 1em; border-radius: 10px; background: var(--ur-surface); border: 1px solid var(--ur-border); }
            .ur-stat-value { font-size: 1.3em; font-weight: 700; font-variant-numeric: tabular-nums; }
            .ur-stat-label { font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ur-muted); }
            .ur-section { margin-top: 2.2em; }
            .ur-section-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.3em 0.75em; margin-bottom: 0.9em; }
            .ur-section-title { margin: 0; font-size: 1.25em; font-weight: 600; }

            .ur-row {
                display: grid; grid-auto-flow: column; grid-auto-columns: clamp(112px, 30vw, 170px); gap: 1em;
                overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity;
                padding: 0.25em 0 0.8em; scrollbar-width: thin;
            }
            .ur-row > * { scroll-snap-align: start; }
            .ur-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(104px, 28vw, 165px), 1fr)); gap: 1.3em 1em; }

            .ur-poster-card { display: block; min-width: 0; color: inherit; text-decoration: none; outline: none; }
            .ur-poster {
                position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden;
                background: linear-gradient(135deg, #2b303b, #181b21);
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
                transition: transform 0.18s ease, box-shadow 0.18s ease;
            }
            .ur-poster img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
            .ur-poster-fallback { position: absolute; inset: 0; display: grid; place-items: center; font-size: 2.6em; font-weight: 700; color: rgba(255, 255, 255, 0.25); }
            .ur-poster-card:hover .ur-poster, .ur-poster-card:focus-visible .ur-poster {
                transform: translateY(-3px);
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5), 0 0 0 2px var(--ur-accent);
            }
            .ur-badge {
                position: absolute; top: 0.45em; right: 0.45em; display: inline-flex; align-items: center; gap: 0.25em;
                padding: 0.25em 0.5em; border-radius: 6px; font-size: 0.8em; font-weight: 700;
                background: rgba(0, 0, 0, 0.78); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
            }
            .ur-badge-count { font-weight: 500; opacity: 0.65; }
            .ur-poster-title { margin-top: 0.55em; font-size: 0.92em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ur-poster-sub { font-size: 0.8em; color: var(--ur-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            .ur-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75em; margin-bottom: 1.3em; }
            .ur-chips { display: flex; flex-wrap: wrap; gap: 0.4em; }
            .ur-chip {
                appearance: none; font: inherit; font-size: 0.88em; color: inherit; cursor: pointer;
                padding: 0.4em 1em; border-radius: 999px; border: 1px solid var(--ur-border); background: var(--ur-surface);
                transition: background-color 0.15s, border-color 0.15s;
            }
            .ur-chip:hover { background: var(--ur-surface-2); }
            .ur-chip:focus-visible, .ur-select:focus-visible, .ur-page-btn:focus-visible { outline: 2px solid var(--ur-accent); outline-offset: 2px; }
            .ur-chip-active, .ur-chip-active:hover { background: var(--ur-accent); border-color: var(--ur-accent); color: #fff; }
            .ur-sort-label { display: flex; align-items: center; gap: 0.6em; font-size: 0.9em; }
            .ur-select {
                appearance: none; -webkit-appearance: none; font: inherit; color: inherit; cursor: pointer;
                padding: 0.45em 2.2em 0.45em 0.85em; border-radius: 8px; border: 1px solid var(--ur-border);
                background: var(--ur-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23fff' stroke-opacity='.6' fill='none' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 0.8em center;
            }
            .ur-select option { background: #1c1c1e; color: #fff; }
            .ur-pager { display: flex; align-items: center; justify-content: center; gap: 1em; margin-top: 2em; }
            .ur-page-btn {
                width: 2.6em; height: 2.6em; border-radius: 50%; font: inherit; font-size: 1.1em; line-height: 1;
                color: inherit; cursor: pointer; background: var(--ur-surface); border: 1px solid var(--ur-border);
            }
            .ur-page-btn:hover:not(:disabled) { background: var(--ur-surface-2); }
            .ur-page-btn:disabled { opacity: 0.35; cursor: default; }

            /* Responsive */
            @media (max-width: 760px) {
                .ur-card { padding: 1em 1.1em; }
                .ur-score { font-size: 2.6em; }
                .ur-star { font-size: 2.4em; padding: 0.05em 0.1em; }
                .ur-actions { width: 100%; }
                .ur-actions .ur-button { flex: 1; padding: 0.75em 1em; }
            }
            @media (max-width: 600px) {
                .ur-hero { align-items: stretch; }
                .ur-stats { width: 100%; }
                .ur-stat { flex: 1; min-width: 0; padding: 0.5em 0.7em; }
                .ur-toolbar { flex-direction: column; align-items: stretch; }
                .ur-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
                .ur-chip { flex: none; }
                .ur-sort-label { justify-content: space-between; }
                .ur-select { flex: 1; }
                .ur-grid { gap: 1em 0.7em; }
                .ur-row { gap: 0.75em; }
            }
            @media (prefers-reduced-motion: reduce) {
                .ur-root *, .ur-root *::before, .ur-root *::after { transition: none !important; }
            }
        `;
        document.head.appendChild(style);
    }
})();
