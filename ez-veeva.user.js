  // ==UserScript==
  // @name         EZ Veeva Helper
  // @namespace    http://tampermonkey.net/
  // @version      2026-10-22.01
  // @homepageURL  https://github.com/ryan-parnell/ez-veeva
  // @supportURL   https://github.com/ryan-parnell/ez-veeva/issues
  // @updateURL    https://raw.githubusercontent.com/ryan-parnell/ez-veeva/main/ez-veeva.user.js
  // @downloadURL  https://raw.githubusercontent.com/ryan-parnell/ez-veeva/main/ez-veeva.user.js
  // @description  Enhances Veeva Vault with easier document search, navigation, bulk actions, and related document tools.
  // @author       Ryan Parnell
  // @match        https://*.veevavault.com/*
  // @icon         https://www.google.com/s2/favicons?sz=64&domain=veevavault.com
  // @run-at       document-start
  // @grant        GM_cookie
  // @grant        GM.cookie
  // @grant        GM_xmlhttpRequest
  // @grant        unsafeWindow
  // @connect      localhost
  // ==/UserScript==

  (function () {
      'use strict';

      const PAGE_SIZE_KEY = 'veevaPreferredChunkSize';
      const ALLOWED_PAGE_SIZES = [5, 25, 50, 100];

      // ---- Feature toggles ------------------------------------------------
      const FEATURE_SETTINGS_KEY = 'veevaHelperFeatureSettings';
      const FEATURE_DEFINITIONS = [
          { key: 'bulkSelect', label: 'Document checkboxes & bulk actions', description: 'Row checkboxes, Select All, Copy Selected and Add to Cart.' },
          { key: 'batchCopy', label: 'Copy first matching links (1000 / 5000)', description: 'Copies links for the first N documents in the current search.' },
          { key: 'pageSize', label: 'Custom page sizes', description: '5/25/50/100 results-per-page selector (reloads the page).' },
          { key: 'findById', label: 'Find By ID', requiresApi: true, description: 'Adds a Find By ID button next to the search bar that finds documents by Veeva ID, document number or legacy Documentum object/chronicle ID.' },
          { key: 'relatedDocs', label: 'All Related Documents menu', requiresApi: true, description: 'Adds an All Related Documents item to the document actions (\u22EF) menu that finds related documents in both directions.' }
      ];
      function getFeatureSettings() {
          const defaults = {};
          FEATURE_DEFINITIONS.forEach(f => { defaults[f.key] = true; });
          try {
              const stored = JSON.parse(window.localStorage.getItem(FEATURE_SETTINGS_KEY) || '{}');
              // Migrate the old 'gdmsLookup' toggle to 'findById'.
              if (stored.findById === undefined && stored.gdmsLookup !== undefined) {
                  stored.findById = stored.gdmsLookup;
              }
              delete stored.gdmsLookup;
              return Object.assign(defaults, stored);
          } catch (error) {
              return defaults;
          }
      }
      let featureSettings = getFeatureSettings();
      function isFeatureEnabled(key) {
          return featureSettings[key] !== false;
      }

      const SELECTORS = {
          documentLink: 'a.vv-action-link-link-anchor[href^="#doc_info/"]',
          documentCell: '.vv-action-link-view-cell',
          favoriteContainer: '.vv-action-link-favorite-button',
          mimeImage: 'img.vv-action-link-mime-type-image',
          checkbox: 'input.veeva-copy-link-checkbox',
          selectionToolbar: '#veeva-selection-toolbar',
          selectAllCheckbox: '#veeva-select-all',
          pageSizeSelect: '#veeva-page-size-select',
          pageSizeControl: '#veeva-page-size-control',
          copyButton: '#veeva-copy-links-button',
          addToCartButton: '#veeva-add-selected-to-cart-button',
          customPager: '#veeva-custom-pager',
          copyAllLimit: '#veeva-copy-all-limit',
          copyAllButton: '#veeva-copy-all-links-button'
      };

      let refreshQueued = false;
      let copyFeedbackActive = false;
      let copyFeedbackTimer = null;
      let currentPage = 1;
      let totalResults = null;
      let requestedPageOverride = null;
      let nativePreviousButton = null;
      let nativeNextButton = null;
      let rawFetch = null;
      let lastSearchUrl = null;
      let lastSearchPayload = null;
      let lastSearchHeaders = {};
      let bulkCopyActive = false;
      let addToCartActive = false;

      function getPreferredPageSize() {
          const value = Number.parseInt(window.localStorage.getItem(PAGE_SIZE_KEY) || '25', 10);
          return ALLOWED_PAGE_SIZES.includes(value) ? value : 25;
      }

      function rememberSearchRequest(url, body, headers) {
          try {
              const payload = typeof body === 'string' ? JSON.parse(body) : body;
              const urlText = String(url || '');
              if (!payload || payload.configName !== 'library__v' ||
                  payload.searchType !== 'document' ||
                  !urlText.includes('/ui/datasource/library__v/') ||
                  !urlText.includes('/document/search/')) return;

              lastSearchUrl = urlText;
              lastSearchPayload = JSON.parse(JSON.stringify(payload));
              if (headers) {
                  if (headers instanceof Headers) {
                      lastSearchHeaders = Object.fromEntries(headers.entries());
                  } else if (Array.isArray(headers)) {
                      lastSearchHeaders = Object.fromEntries(headers);
                  } else {
                      lastSearchHeaders = Object.assign({}, headers);
                  }
              }
          } catch (error) {
              // Ignore requests that cannot be captured.
          }
      }

      function rewriteSearchBody(body) {
          if (typeof body !== 'string') return body;

          try {
              const payload = JSON.parse(body);
              if (payload.configName === 'library__v' && payload.searchType === 'document') {
                  if (!isFeatureEnabled('pageSize')) return body;
                  payload.chunkSize = getPreferredPageSize();
                  if (requestedPageOverride !== null) {
                      payload.page = requestedPageOverride;
                  }
                  currentPage = Number.parseInt(payload.page, 10) || currentPage || 1;
                  return JSON.stringify(payload);
              }
          } catch (error) {
              // Ignore request bodies that are not JSON.
          }

          return body;
      }

      function captureSearchResponse(data) {
          if (!data || typeof data !== 'object') return;
          if (Number.isFinite(Number(data.total))) {
              totalResults = Number(data.total);
          }
          queueEnhancement();
      }

      function rewriteSearchUrl(url) {
          const text = String(url || '');
          if (requestedPageOverride === null ||
              !text.includes('/ui/datasource/library__v/') ||
              !text.includes('/document/search/')) {
              return url;
          }
          return text.replace(/\/document\/search\/\d+(?=\?|$)/, `/document/search/${requestedPageOverride}`);
      }

      function installPageSizeInterceptors() {
          const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
          if (pageWindow.__veevaPageSizeInterceptorsInstalled) return;
          pageWindow.__veevaPageSizeInterceptorsInstalled = true;

          const originalFetch = pageWindow.fetch;
          rawFetch = typeof originalFetch === 'function' ? originalFetch.bind(pageWindow) : null;
          if (typeof originalFetch === 'function') {
              pageWindow.fetch = async function (input, init) {
                  let isLibrarySearch = false;
                  rememberSearchRequest(input, init && init.body, init && init.headers);
                  const rewrittenInput = rewriteSearchUrl(input);
                  if (init && typeof init.body === 'string') {
                      const rewrittenBody = rewriteSearchBody(init.body);
                      isLibrarySearch = rewrittenBody !== init.body ||
                          String(input || '').includes('/ui/datasource/library__v/');
                      init = Object.assign({}, init, { body: rewrittenBody });
                  }

                  const responsePromise = originalFetch.call(this, rewrittenInput, init);
                  if (isLibrarySearch) requestedPageOverride = null;
                  const response = await responsePromise;
                  if (isLibrarySearch) {
                      response.clone().json().then(captureSearchResponse).catch(() => {});
                  }
                  return response;
              };
          }

          const originalOpen = pageWindow.XMLHttpRequest.prototype.open;
          const originalSend = pageWindow.XMLHttpRequest.prototype.send;
          const originalSetRequestHeader = pageWindow.XMLHttpRequest.prototype.setRequestHeader;

          pageWindow.XMLHttpRequest.prototype.open = function (method, url) {
              const rewrittenUrl = rewriteSearchUrl(url);
              this.__veevaRequestUrl = String(rewrittenUrl || '');
              this.__veevaRequestHeaders = {};
              const args = Array.from(arguments);
              args[1] = rewrittenUrl;
              return originalOpen.apply(this, args);
          };

          pageWindow.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
              if (this.__veevaRequestHeaders) {
                  this.__veevaRequestHeaders[name] = value;
              }
              return originalSetRequestHeader.apply(this, arguments);
          };

          pageWindow.XMLHttpRequest.prototype.send = function (body) {
              const isLibrarySearch =
                  this.__veevaRequestUrl.includes('/ui/datasource/library__v/') &&
                  this.__veevaRequestUrl.includes('/document/search/');

              if (isLibrarySearch) {
                  rememberSearchRequest(this.__veevaRequestUrl, body, this.__veevaRequestHeaders);
                  body = rewriteSearchBody(body);
                  this.addEventListener('load', function () {
                      try {
                          const data = this.responseType === 'json'
                              ? this.response
                              : JSON.parse(this.responseText);
                          captureSearchResponse(data);
                      } catch (error) {
                          // Ignore non-JSON responses.
                      }
                  }, { once: true });
              }
              const result = originalSend.call(this, body);
              if (isLibrarySearch) requestedPageOverride = null;
              return result;
          };
      }

      installPageSizeInterceptors();

      function replaceMiddle(originalString) {
          if (!originalString) return '';
          if (originalString.length <= 60) return originalString;
          return originalString.substring(0, 30) + '......' +
              originalString.substring(Math.max(30, originalString.length - 30));
      }

      function copyToClipboard(text) {
          if (navigator.clipboard && window.isSecureContext) {
              return navigator.clipboard.writeText(text);
          }

          return new Promise((resolve, reject) => {
              const textArea = document.createElement('textarea');
              textArea.value = text;
              textArea.style.position = 'fixed';
              textArea.style.left = '-9999px';
              document.body.appendChild(textArea);
              textArea.focus();
              textArea.select();

              try {
                  document.execCommand('copy')
                      ? resolve()
                      : reject(new Error('Copy command failed.'));
              } catch (error) {
                  reject(error);
              } finally {
                  textArea.remove();
              }
          });
      }

      function getSimpleDocumentUrl(link) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/#doc_info\/(\d+)\/\d+\/\d+/i);
          if (!match) return null;

          const documentId = match[1];
          const tabCollection = new URLSearchParams(window.location.search).get('tab-collection') || 'rim__c';
          return `${window.location.origin}/ui/?tab-collection=${encodeURIComponent(tabCollection)}#doc_info/${documentId}/0/1`;
      }

      function addDocumentCheckboxes() {
          if (!isFeatureEnabled('bulkSelect')) return;
          document.querySelectorAll(SELECTORS.documentLink).forEach(link => {
              const cell = link.closest(SELECTORS.documentCell);
              if (!cell || cell.querySelector(SELECTORS.checkbox)) return;

              const favoriteContainer = cell.querySelector(SELECTORS.favoriteContainer);
              const mimeImage = cell.querySelector(SELECTORS.mimeImage);
              const mimeContainer = mimeImage ? mimeImage.parentElement : null;
              if (!favoriteContainer || !mimeContainer) return;

              const wrapper = document.createElement('div');
              wrapper.className = 'veeva-copy-link-checkbox-container';
              wrapper.style.cssText = 'display:flex;align-items:center;justify-content:center;margin:0 7px 0 3px;flex:0 0 auto;';

              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.className = 'veeva-copy-link-checkbox';
              checkbox.setAttribute('aria-label', `Select document ${link.textContent.trim()}`);
              checkbox.dataset.simpleUrl = getSimpleDocumentUrl(link) || '';
              const documentIdMatch = (link.getAttribute('href') || '').match(/#doc_info\/(\d+)\//i);
              checkbox.dataset.documentId = documentIdMatch ? documentIdMatch[1] : '';
              checkbox.style.cssText = 'width:15px;height:15px;margin:0;cursor:pointer;';
              checkbox.addEventListener('click', event => event.stopPropagation());
              checkbox.addEventListener('change', updateSelectionToolbar);

              wrapper.appendChild(checkbox);
              favoriteContainer.insertAdjacentElement('afterend', wrapper);
          });
      }

      function getVisibleCheckboxes() {
          return Array.from(document.querySelectorAll(SELECTORS.checkbox))
              .filter(box => box.offsetParent !== null);
      }

      function updateSelectionToolbar() {
          const selectAll = document.querySelector(SELECTORS.selectAllCheckbox);
          const copyButton = document.querySelector(SELECTORS.copyButton);
          const addToCartButton = document.querySelector(SELECTORS.addToCartButton);
          const boxes = getVisibleCheckboxes();
          const selectedCount = boxes.filter(box => box.checked).length;

          if (selectAll) {
              selectAll.checked = boxes.length > 0 && selectedCount === boxes.length;
              selectAll.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
              selectAll.disabled = boxes.length === 0;
          }

          if (copyButton) {
              if (!copyFeedbackActive) {
                  copyButton.textContent = selectedCount > 0
                      ? `Copy ${selectedCount} Selected`
                      : 'Copy Selected';
              }
              copyButton.disabled = selectedCount === 0;
          }

          if (addToCartButton && !addToCartActive) {
              addToCartButton.textContent = selectedCount > 0
                  ? `Add ${selectedCount} to Cart`
                  : 'Add to Cart';
              addToCartButton.disabled = selectedCount === 0;
          }
      }

      function toggleAllCheckboxes(event) {
          const shouldCheck = event.currentTarget.checked;
          getVisibleCheckboxes().forEach(box => {
              box.checked = shouldCheck;
          });
          updateSelectionToolbar();
      }

      function findSearchGridToolbar() {
          const paginator = document.querySelector(
              '.vv-expanded-search-paginator, .vv-expanded-search-platform-paginator, [class*="Pagination-module__container"]'
          );
          return paginator ? paginator.closest('[role="toolbar"], .vv-search-grid-toolbar') : null;
      }

      function createPageSizeSelector() {
          const wrapper = document.createElement('label');
          wrapper.id = 'veeva-page-size-control';
          wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-left:12px;font-weight:normal;white-space:nowrap;';

          const labelText = document.createElement('span');
          labelText.textContent = 'Results per page:';

          const select = document.createElement('select');
          select.id = 'veeva-page-size-select';
          select.title = 'Results per page';
          select.setAttribute('aria-label', 'Results per page');
          select.style.cssText = 'height:28px;padding:2px 24px 2px 7px;cursor:pointer;';

          ALLOWED_PAGE_SIZES.forEach(size => {
              const option = document.createElement('option');
              option.value = String(size);
              option.textContent = String(size);
              select.appendChild(option);
          });

          select.value = String(getPreferredPageSize());
          select.addEventListener('change', () => {
              const selectedSize = Number.parseInt(select.value, 10);
              if (!ALLOWED_PAGE_SIZES.includes(selectedSize)) return;

              window.localStorage.setItem(PAGE_SIZE_KEY, String(selectedSize));
              currentPage = 1;
              window.location.reload();
          });

          wrapper.append(labelText, select);
          return wrapper;
      }

      function addPageSizeSelectorToPaginator() {
          if (!isFeatureEnabled('pageSize')) return;
          if (document.querySelector(SELECTORS.pageSizeControl)) return;

          const paginator = document.querySelector(
              '.vv-expanded-search-paginator, .vv-expanded-search-platform-paginator, [class*="Pagination-module__container"]'
          );
          if (!paginator) return;

          const directSpans = Array.from(paginator.children)
              .filter(element => element.tagName === 'SPAN');
          const resultCount = directSpans.find(element =>
              /^\s*\d[\d,]*\s*-\s*\d[\d,]*\s+of\b/i.test(element.textContent || '')
          ) || directSpans[0];

          if (!resultCount) return;
          resultCount.insertAdjacentElement('afterend', createPageSizeSelector());
      }

      function getPaginator() {
          return document.querySelector(
              '.vv-expanded-search-paginator, .vv-expanded-search-platform-paginator, [class*="Pagination-module__container"]'
          );
      }

      function getNativePageInput() {
          const paginator = getPaginator();
          return paginator ? paginator.querySelector('input[aria-label^="Page"], input[type="text"]') : null;
      }

      function navigateToPage(pageNumber) {
          const pageSize = getPreferredPageSize();
          const totalPages = totalResults === null
              ? null
              : Math.max(1, Math.ceil(totalResults / pageSize));
          const targetPage = Math.max(1, totalPages === null
              ? pageNumber
              : Math.min(pageNumber, totalPages));

          if (targetPage === currentPage) return;

          const paginator = getPaginator();
          if (!paginator) return;

          const usePrevious = targetPage < currentPage;
          const trigger = usePrevious ? nativePreviousButton : nativeNextButton;

          if (!trigger || !trigger.isConnected) {
              console.warn('[Veeva Helper] Cached native paging trigger is unavailable.');
              return;
          }

          requestedPageOverride = targetPage;
          currentPage = targetPage;
          addCustomPager();
          trigger.click();

          window.setTimeout(() => {
              if (requestedPageOverride !== null) {
                  requestedPageOverride = null;
                  console.warn('[Veeva Helper] Veeva did not issue a paging request.');
              }
          }, 1500);
      }

      function updateResultCount() {
          if (!isFeatureEnabled('pageSize')) return;
          if (totalResults === null) return;
          const paginator = getPaginator();
          if (!paginator) return;

          const countSpan = Array.from(paginator.children).find(element =>
              element.tagName === 'SPAN' &&
              /^\s*\d[\d,]*\s*-\s*\d[\d,]*\s+of\b/i.test(element.textContent || '')
          );
          if (!countSpan) return;

          const pageSize = getPreferredPageSize();
          const start = totalResults === 0 ? 0 : ((currentPage - 1) * pageSize) + 1;
          const end = Math.min(currentPage * pageSize, totalResults);
          countSpan.textContent = `${start}-${end} of about ${totalResults.toLocaleString('en-US')}`;
      }

      function addCustomPager() {
          if (!isFeatureEnabled('pageSize')) return;
          const paginator = getPaginator();
          if (!paginator) return;

          // Capture Veeva's real React paging buttons before hiding their
          // container. At runtime they may not retain title/aria attributes,
          // so identify them by the angle-left/angle-right SVG icons first.
          if (!nativePreviousButton || !nativePreviousButton.isConnected) {
              const leftIcon = paginator.querySelector(
                  'svg[data-icon="angle-left"], svg.fa-angle-left'
              );
              nativePreviousButton = leftIcon ? leftIcon.closest('button') : null;
          }
          if (!nativeNextButton || !nativeNextButton.isConnected) {
              const rightIcon = paginator.querySelector(
                  'svg[data-icon="angle-right"], svg.fa-angle-right'
              );
              nativeNextButton = rightIcon ? rightIcon.closest('button') : null;
          }

          // Fallback for builds where the SVG metadata is removed. Use only
          // non-userscript buttons and preserve DOM order: previous, next.
          if (!nativePreviousButton || !nativeNextButton) {
              const candidates = Array.from(paginator.querySelectorAll('button'))
                  .filter(button => !button.closest(SELECTORS.customPager));
              if (!nativePreviousButton && candidates.length > 0) {
                  nativePreviousButton = candidates[0];
              }
              if (!nativeNextButton && candidates.length > 1) {
                  nativeNextButton = candidates[candidates.length - 1];
              }
          }

          const nativeControls = nativePreviousButton
              ? nativePreviousButton.closest('span')
              : (nativeNextButton ? nativeNextButton.closest('span') : null);
          if (nativeControls && !nativeControls.matches(SELECTORS.customPager)) {
              nativeControls.style.display = 'none';
          }

          let pager = document.querySelector(SELECTORS.customPager);
          if (!pager) {
              pager = document.createElement('span');
              pager.id = 'veeva-custom-pager';
              pager.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:12px;white-space:nowrap;';

              const previous = document.createElement('button');
              previous.type = 'button';
              previous.dataset.action = 'previous';
              previous.textContent = '<<';
              previous.title = 'Previous page';
              previous.addEventListener('click', () => navigateToPage(currentPage - 1));

              const pageLabel = document.createElement('span');
              pageLabel.dataset.role = 'page-label';

              const next = document.createElement('button');
              next.type = 'button';
              next.dataset.action = 'next';
              next.textContent = '>>';
              next.title = 'Next page';
              next.addEventListener('click', () => navigateToPage(currentPage + 1));

              const last = document.createElement('button');
              last.type = 'button';
              last.dataset.action = 'last';
              last.textContent = '>>|';
              last.title = 'Last page';
              last.addEventListener('click', () => {
                  if (totalResults === null) return;
                  navigateToPage(Math.max(1, Math.ceil(totalResults / getPreferredPageSize())));
              });

              pager.append(previous, pageLabel, next, last);
              paginator.appendChild(pager);
          }

          const pageSize = getPreferredPageSize();
          const totalPages = totalResults === null
              ? null
              : Math.max(1, Math.ceil(totalResults / pageSize));
          const pageLabel = pager.querySelector('[data-role="page-label"]');
          const previous = pager.querySelector('[data-action="previous"]');
          const next = pager.querySelector('[data-action="next"]');
          const last = pager.querySelector('[data-action="last"]');

          pageLabel.textContent = totalPages === null
              ? `Page ${currentPage}`
              : `Page ${currentPage} of ${totalPages.toLocaleString('en-US')}`;
          previous.disabled = currentPage <= 1;
          next.disabled = totalPages !== null && currentPage >= totalPages;
          last.disabled = totalPages === null || currentPage >= totalPages;
          updateResultCount();
      }

      function buildSimpleDocumentUrl(documentId) {
          const tabCollection = new URLSearchParams(window.location.search)
              .get('tab-collection') || 'rim__c';
          return `${window.location.origin}/ui/?tab-collection=${encodeURIComponent(tabCollection)}#doc_info/${documentId}/0/1`;
      }

      function setBulkButtonStatus(button, text, color) {
          button.textContent = text;
          button.style.color = color || '';
      }

      async function copyMatchingLinks(button) {
          if (bulkCopyActive) return;
          if (!lastSearchUrl || !lastSearchPayload || !rawFetch) {
              alert('Run or refresh the current Veeva document search first.');
              return;
          }

          const limitSelect = document.querySelector(SELECTORS.copyAllLimit);
          const requestedLimit = Number.parseInt(limitSelect ? limitSelect.value : '1000', 10);
          const effectiveTotal = totalResults === null
              ? requestedLimit
              : Math.min(requestedLimit, totalResults);
          const batchSize = 200;
          const totalPagesToFetch = Math.ceil(effectiveTotal / batchSize);
          const documentIds = new Set();
          const originalText = button.textContent;
          const originalColor = button.style.color;

          bulkCopyActive = true;
          button.disabled = true;
          if (limitSelect) limitSelect.disabled = true;

          try {
              for (let page = 1; page <= totalPagesToFetch; page += 1) {
                  const payload = JSON.parse(JSON.stringify(lastSearchPayload));
                  payload.page = page;
                  payload.chunkSize = batchSize;
                  if (!Array.isArray(payload.fields)) payload.fields = [];
                  if (!payload.fields.includes('DocumentId')) payload.fields.push('DocumentId');

                  const pageUrl = lastSearchUrl.replace(
                      /\/document\/search\/\d+(?=\?|$)/,
                      `/document/search/${page}`
                  );
                  const headers = Object.assign({}, lastSearchHeaders, {
                      'content-type': 'application/json; charset=UTF-8',
                      'x-requested-with': 'XMLHttpRequest'
                  });

                  const response = await rawFetch(pageUrl, {
                      method: 'POST',
                      credentials: 'include',
                      headers,
                      body: JSON.stringify(payload)
                  });
                  if (!response.ok) {
                      throw new Error(`Search request failed with status ${response.status}.`);
                  }

                  const data = await response.json();
                  if (!Array.isArray(data.items)) {
                      throw new Error('The search response did not contain an items array.');
                  }

                  for (const item of data.items) {
                      if (item && item.DocumentId !== undefined && item.DocumentId !== null) {
                          documentIds.add(String(item.DocumentId));
                          if (documentIds.size >= effectiveTotal) break;
                      }
                  }

                  setBulkButtonStatus(
                      button,
                      `Retrieving ${documentIds.size.toLocaleString('en-US')} of ${effectiveTotal.toLocaleString('en-US')}...`
                  );

                  if (documentIds.size >= effectiveTotal || data.items.length === 0) break;
              }

              const urls = Array.from(documentIds, buildSimpleDocumentUrl);
              await copyToClipboard(urls.join('\r\n'));
              setBulkButtonStatus(
                  button,
                  `✓ Copied ${urls.length.toLocaleString('en-US')} Links`,
                  '#008000'
              );

              window.setTimeout(() => {
                  if (!button.isConnected) return;
                  button.textContent = originalText;
                  button.style.color = originalColor;
              }, 2000);
          } catch (error) {
              console.error('[Veeva Helper] Failed to copy matching links:', error);
              alert(`Failed to copy matching links: ${error.message}`);
              button.textContent = originalText;
              button.style.color = originalColor;
          } finally {
              bulkCopyActive = false;
              button.disabled = false;
              if (limitSelect) limitSelect.disabled = false;
          }
      }

      function incrementVisibleCartCount(amount) {
          if (!Number.isFinite(amount) || amount <= 0) return;
          const cartBadge = document.querySelector('.vv-navbar-cart-count');
          if (!cartBadge) {
              console.warn('[Veeva Helper] Cart count badge was not found.');
              return;
          }
          const currentCount = Number.parseInt(
              (cartBadge.textContent || '').replace(/[^0-9]/g, ''), 10
          ) || 0;
          const originalBackground = cartBadge.style.backgroundColor;
          const originalColor = cartBadge.style.color;
          const originalTransition = cartBadge.style.transition;
          cartBadge.textContent = String(currentCount + amount);
          cartBadge.style.transition = 'background-color 150ms ease, color 150ms ease';
          cartBadge.style.backgroundColor = '#34a853';
          cartBadge.style.color = '#ffffff';
          window.setTimeout(() => {
              if (!cartBadge.isConnected) return;
              cartBadge.style.backgroundColor = originalBackground;
              cartBadge.style.color = originalColor;
              cartBadge.style.transition = originalTransition;
          }, 2000);
      }

      async function addSelectedDocumentsToCart(button) {
          if (addToCartActive) return;
          const selected = getVisibleCheckboxes()
              .filter(box => box.checked && box.dataset.documentId);
          if (selected.length === 0) {
              alert('Select at least one document first.');
              return;
          }
          const documentIds = [...new Set(selected.map(box => box.dataset.documentId))];
          const originalStyles = {
              color: button.style.color,
              background: button.style.background,
              borderColor: button.style.borderColor
          };
          let addedCount = 0;
          const failures = [];
          addToCartActive = true;
          button.disabled = true;
          try {
              for (let index = 0; index < documentIds.length; index += 1) {
                  const documentId = documentIds[index];
                  button.textContent = `Adding ${index + 1} of ${documentIds.length}...`;
                  if (!rawFetch) throw new Error('The page-level fetch function is unavailable.');
                  const basketHeaders = Object.assign({}, lastSearchHeaders, {
                      'accept': 'application/json, text/javascript, */*; q=0.01',
                      'cache-control': 'no-cache',
                      'pragma': 'no-cache',
                      'x-requested-with': 'XMLHttpRequest',
                      'x-veeva-device-information': JSON.stringify({
                          isTouchEnabled: navigator.maxTouchPoints > 0,
                          platformName: navigator.platform || 'Windows'
                      }),
                      'x-veeva-url-fragment': window.location.hash.replace(/^#/, '')
                  });
                  const response = await rawFetch(
                      `/ui/basket/add/${encodeURIComponent(documentId)}?_=${Date.now()}`,
                      {
                          method: 'GET', mode: 'cors', credentials: 'include',
                          referrer: `${window.location.origin}/ui/?tab-collection=${
                              new URLSearchParams(window.location.search).get('tab-collection') || 'rim__c'
                          }`,
                          headers: basketHeaders
                      }
                  );
                  const responseText = await response.text();
                  const sessionInvalid = /sessionInvalid|Invalid Session|accessDenied/i.test(responseText);
                  const applicationError = /error|failed/i.test(responseText) &&
                      !/^\s*\{?[\s\S]*success[\s\S]*true/i.test(responseText);
                  if (response.ok && !sessionInvalid && !applicationError) {
                      addedCount += 1;
                  } else {
                      failures.push({ documentId, status: response.status,
                          response: responseText.substring(0, 500) });
                  }
              }
              incrementVisibleCartCount(addedCount);
              if (failures.length === 0) {
                  button.textContent = `Added ${addedCount} to Cart`;
                  button.style.color = '#137333';
                  button.style.background = '#e6f4ea';
                  button.style.borderColor = '#34a853';
              } else {
                  button.textContent = `Added ${addedCount}; ${failures.length} Failed`;
                  button.style.color = '#b06000';
                  button.style.background = '#fff4ce';
                  button.style.borderColor = '#d6a400';
                  console.warn('[Veeva Helper] Documents not added to cart:', failures);
              }
              window.setTimeout(() => {
                  if (!button.isConnected) return;
                  button.style.color = originalStyles.color;
                  button.style.background = originalStyles.background;
                  button.style.borderColor = originalStyles.borderColor;
                  addToCartActive = false;
                  updateSelectionToolbar();
              }, 2000);
          } catch (error) {
              addToCartActive = false;
              button.style.color = originalStyles.color;
              button.style.background = originalStyles.background;
              button.style.borderColor = originalStyles.borderColor;
              console.error('[Veeva Helper] Failed to add selected documents to cart:', error);
              alert(`Failed to add selected documents to the cart: ${error.message}`);
              updateSelectionToolbar();
          }
      }

      function addSelectionToolbar() {
          if (document.querySelector(SELECTORS.selectionToolbar)) return;
          const showSelected = isFeatureEnabled('bulkSelect');
          const showMatching = isFeatureEnabled('batchCopy');
          if (!showSelected && !showMatching) return;
          const gridToolbar = findSearchGridToolbar();
          if (!gridToolbar) return;

          const leftToolbarItem = gridToolbar.querySelector('[data-corgix-internal="TOOLBAR-ITEM"]');
          if (!leftToolbarItem) return;

          const toolbar = document.createElement('div');
          toolbar.id = 'veeva-selection-toolbar';
          toolbar.style.cssText = 'display:flex;align-items:center;min-height:32px;white-space:nowrap;flex-wrap:wrap;';

          const selectLabel = document.createElement('label');
          selectLabel.htmlFor = 'veeva-select-all';
          selectLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;margin:0;';

          const selectAll = document.createElement('input');
          selectAll.type = 'checkbox';
          selectAll.id = 'veeva-select-all';
          selectAll.setAttribute('aria-label', 'Select all documents on this page');
          selectAll.style.cssText = 'width:15px;height:15px;margin:0;cursor:pointer;';
          selectAll.addEventListener('change', toggleAllCheckboxes);

          const labelText = document.createElement('span');
          labelText.textContent = 'Select All';

          const copyButton = document.createElement('button');
          copyButton.id = 'veeva-copy-links-button';
          copyButton.type = 'button';
          copyButton.textContent = 'Copy Selected';
          copyButton.title = 'Copy simple URLs for checked documents';
          copyButton.style.cssText = 'padding:5px 12px;cursor:pointer;background:#f3f3f3;border:1px solid #c8c8c8;border-radius:3px;color:#222;';
          copyButton.addEventListener('click', () => copySelectedLinks(copyButton));

          const addToCartButton = document.createElement('button');
          addToCartButton.id = 'veeva-add-selected-to-cart-button';
          addToCartButton.type = 'button';
          addToCartButton.textContent = 'Add to Cart';
          addToCartButton.title = 'Add checked documents to the Veeva cart';
          addToCartButton.style.cssText = 'padding:5px 12px;cursor:pointer;background:#f3f3f3;border:1px solid #c8c8c8;border-radius:3px;color:#222;';
          addToCartButton.addEventListener('click', () => addSelectedDocumentsToCart(addToCartButton));

          const copyAllLimit = document.createElement('select');
          copyAllLimit.id = 'veeva-copy-all-limit';
          copyAllLimit.title = 'Maximum matching links to copy';
          copyAllLimit.setAttribute('aria-label', 'Maximum matching links to copy');
          copyAllLimit.style.cssText = 'height:28px;padding:2px 22px 2px 6px;cursor:pointer;';
          [1000, 5000].forEach(limit => {
              const option = document.createElement('option');
              option.value = String(limit);
              option.textContent = String(limit);
              copyAllLimit.appendChild(option);
          });

          const copyAllButton = document.createElement('button');
          copyAllButton.id = 'veeva-copy-all-links-button';
          copyAllButton.type = 'button';
          copyAllButton.textContent = 'Copy Matching';
          copyAllButton.title = 'Copy matching search-result links up to the selected limit';
          copyAllButton.style.cssText = 'padding:5px 12px;cursor:pointer;background:#eef5ff;border:1px solid #4a7cff;border-radius:3px;color:#174ea6;font-weight:600;';
          copyAllButton.addEventListener('click', () => copyMatchingLinks(copyAllButton));

          const easyLinkCopyPanel = document.createElement('fieldset');
          easyLinkCopyPanel.id = 'veeva-easy-link-copy-panel';
          easyLinkCopyPanel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:1px 0;padding:3px 8px 4px;border:1px solid #b8c9e3;border-radius:6px;background:#fbfdff;min-width:0;';

          const panelTitle = document.createElement('legend');
          panelTitle.textContent = 'Easy Link Copy';
          panelTitle.style.cssText = 'padding:0 5px;font-weight:700;color:#174ea6;font-size:12px;line-height:1;';

          const selectedGroup = document.createElement('div');
          selectedGroup.style.cssText = 'display:inline-flex;align-items:center;gap:7px;padding-right:10px;margin-right:4px;border-right:1px solid #d0d0d0;';

          const selectedHeading = document.createElement('span');
          selectedHeading.textContent = '';
          selectedHeading.style.cssText = 'font-weight:600;color:#333;';

          const matchingGroup = document.createElement('div');
          matchingGroup.style.cssText = 'display:inline-flex;align-items:center;gap:7px;';

          const matchingHeading = document.createElement('span');
          matchingHeading.textContent = 'First Matching:';
          matchingHeading.style.cssText = 'font-weight:600;color:#174ea6;';

          selectLabel.append(selectAll, labelText);
          selectedGroup.append(selectedHeading, copyButton, addToCartButton);
          matchingGroup.append(matchingHeading, copyAllLimit, copyAllButton);
          easyLinkCopyPanel.appendChild(panelTitle);
          if (showSelected) {
              if (!showMatching) {
                  selectedGroup.style.borderRight = '0';
                  selectedGroup.style.paddingRight = '0';
                  selectedGroup.style.marginRight = '0';
              }
              easyLinkCopyPanel.append(selectLabel, selectedGroup);
          }
          if (showMatching) easyLinkCopyPanel.appendChild(matchingGroup);
          toolbar.appendChild(easyLinkCopyPanel);
          leftToolbarItem.appendChild(toolbar);
          updateSelectionToolbar();
      }

      async function copySelectedLinks(button) {
          const selected = getVisibleCheckboxes()
              .filter(box => box.checked && box.dataset.simpleUrl);

          if (selected.length === 0) {
              alert('Select at least one document first.');
              return;
          }

          const urls = [...new Set(selected.map(box => box.dataset.simpleUrl))];

          try {
              await copyToClipboard(urls.join('\r\n'));

              const originalColor = button.style.color;
              const originalFontWeight = button.style.fontWeight;
              copyFeedbackActive = true;

              if (copyFeedbackTimer) {
                  window.clearTimeout(copyFeedbackTimer);
              }

              button.replaceChildren();

              const confirmationContent = document.createElement('span');
              confirmationContent.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

              const checkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              checkIcon.setAttribute('width', '16');
              checkIcon.setAttribute('height', '16');
              checkIcon.setAttribute('viewBox', '0 0 16 16');
              checkIcon.setAttribute('aria-hidden', 'true');
              checkIcon.setAttribute('focusable', 'false');
              checkIcon.style.cssText = 'display:inline-block;flex:0 0 16px;overflow:visible;';

              const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
              checkPath.setAttribute('d', 'M2 8.5 L6 12.5 L14 3.5');
              checkPath.setAttribute('fill', 'none');
              checkPath.setAttribute('stroke', '#008000');
              checkPath.setAttribute('stroke-width', '2.5');
              checkPath.setAttribute('stroke-linecap', 'round');
              checkPath.setAttribute('stroke-linejoin', 'round');
              checkIcon.appendChild(checkPath);

              const confirmationText = document.createElement('span');
              confirmationText.textContent = `Copied ${urls.length} Link${urls.length === 1 ? '' : 's'}`;

              confirmationContent.append(checkIcon, confirmationText);
              button.appendChild(confirmationContent);
              button.style.color = '#008000';
              button.style.fontWeight = '600';

              copyFeedbackTimer = window.setTimeout(() => {
                  copyFeedbackActive = false;
                  copyFeedbackTimer = null;

                  if (!button.isConnected) return;

                  button.style.color = originalColor;
                  button.style.fontWeight = originalFontWeight;
                  updateSelectionToolbar();
              }, 2000);
          } catch (error) {
              copyFeedbackActive = false;
              console.error('Failed to copy document links:', error);
              alert('Failed to copy the document links to the clipboard.');
          }
      }

      // ---- Find By ID (MVP) -----------------------------------------------
      // Finds documents in Vault by any mix of:
      //   - Veeva document IDs (e.g. 1909958, or a #doc_info/1909958/... link)
      //   - Vault document numbers (document_number__v)
      //   - Legacy Documentum object IDs / chronicle IDs (or DRL links)
      // in the latest versions (or ALL versions if selected), using the Vault REST API (VQL) with the current
      // user's session. Assumes the user's security profile allows API access.
      const FIND_API_VERSION = 'v24.1';
      const API_ACCESS_STATUS_KEY = 'ezVeevaApiAccessStatus';
      const FIND_MAX_IDS = 1000;

      function getCachedApiAccess() {
          try {
              const stored = JSON.parse(window.localStorage.getItem(API_ACCESS_STATUS_KEY) || 'null');
              return stored && typeof stored.allowed === 'boolean' ? stored.allowed : null;
          } catch (error) {
              return null;
          }
      }

      function saveApiAccessStatus(allowed) {
          window.localStorage.setItem(API_ACCESS_STATUS_KEY, JSON.stringify({
              allowed: Boolean(allowed),
              checkedAt: new Date().toISOString(),
              apiVersion: FIND_API_VERSION
          }));
      }

      function hasApiAccess() {
          return getCachedApiAccess() === true;
      }

      async function checkApiAccess() {
          try {
              await vaultApi(`/api/${FIND_API_VERSION}/metadata/objects/documents/properties`);
              saveApiAccessStatus(true);
              return { allowed: true, message: 'API access confirmed.' };
          } catch (error) {
              saveApiAccessStatus(false);
              return {
                  allowed: false,
                  message: error && error.message ? error.message : 'API access could not be confirmed.'
              };
          }
      }
      // Queries are batched by length, not by count. Vault's hard limit is
      // 50,000 characters per VQL statement; stay safely below it.
      const VQL_MAX_LENGTH = 45000;
      // ---- Accepted input patterns ----
      // Documentum ID: 16 hex characters starting with 090177e
      const GDMS_ID_TOKEN = /^090177e[0-9a-f]{9}$/i;
      const GDMS_ID_IN_TEXT = /(?:^|[^0-9a-f])(090177e[0-9a-f]{9})(?![0-9a-f])/i;
      // Veeva document ID: digits only
      const VEEVA_ID_IN_LINK = /#doc_info\/(\d+)(?:\/|$)/i;
      const VEEVA_ID_TOKEN = /^\d+$/;
      // Document numbers: ATTACH-{####} and PFE-RIM-<TYPE>-{########}.
      // Counters are minimum widths, so longer numbers are accepted.
      const DOC_NUMBER_PATTERNS = [
          /^ATTACH-\d{4,}$/i,
          /^PFE-RIM-(?:CLIN|LAB|LIT|MIG|NC|PVG|REG|REGQUAL|SA|SC|UDI)-\d{8,}$/i
      ];
      const isDocNumber = token => DOC_NUMBER_PATTERNS.some(re => re.test(token));
      const INPUT_TYPE_LABELS = { gdms: 'GDMS ID', veevaId: 'Veeva ID', docNumber: 'Document #' };
      let findLookupActive = false;
      let findLastResults = [];
      function getSessionId() {
          return new Promise((resolve, reject) => {
              const fromDocumentCookie = () => {
                  const match = document.cookie.match(/(?:^|;\s*)TK=([^;]+)/);
                  return match ? decodeURIComponent(match[1]) : null;
              };
              if (typeof GM_cookie === 'function') {
                  GM_cookie('list', { name: 'TK' }, (cookies, error) => {
                      if (!error && cookies && cookies.length) return resolve(cookies[0].value);
                      const fallback = fromDocumentCookie();
                      fallback ? resolve(fallback) : reject(new Error('Session ID (TK cookie) not found.'));
                  });
                  return;
              }
              const fallback = fromDocumentCookie();
              fallback ? resolve(fallback) : reject(new Error('Session ID (TK cookie) not found.'));
          });
      }
      async function vaultApi(path, options = {}) {
          const sessionId = await getSessionId();
          const doFetch = rawFetch || window.fetch.bind(window);
          const response = await doFetch(path, Object.assign({
              credentials: 'include'
          }, options, {
              headers: Object.assign({
                  'Authorization': sessionId,
                  'Accept': 'application/json'
              }, options.headers || {})
          }));
          const data = await response.json().catch(() => null);
          if (!response.ok || !data) {
              throw new Error(`Vault API request failed (HTTP ${response.status}).`);
          }
          if (data.responseStatus && data.responseStatus !== 'SUCCESS' && data.responseStatus !== 'WARNING') {
              const detail = Array.isArray(data.errors) && data.errors.length
                  ? `${data.errors[0].type}: ${data.errors[0].message}`
                  : data.responseStatus;
              throw new Error(detail);
          }
          return data;
      }
      // ---- Report columns ---------------------------------------------------
      // Fixed columns (always shown, cannot be changed):
      //   Input, Type, Result, Matched On, Document #, Ver, Latest?
      // Optional columns below are user-selectable and remembered in localStorage.
      //   field   : standard Vault field name (validated against metadata)
      //   detect  : custom field auto-detected from the field label
      //   kind    : 'date' | 'user' | 'reference' (display formatting / name lookup)
      const FIND_COLUMNS_KEY = 'ezFindByIdColumns';
      const FIND_OPTIONAL_COLUMNS = [
          { key: 'status', label: 'Status', field: 'status__v', defaultOn: true },
          { key: 'name', label: 'Name', field: 'name__v', defaultOn: true, wide: true },
          { key: 'docType', label: 'Doc Type', field: 'type__v' },
          { key: 'subtype', label: 'Subtype', field: 'subtype__v' },
          { key: 'classification', label: 'Classification', field: 'classification__v' },
          { key: 'lifecycle', label: 'Lifecycle', field: 'lifecycle__v' },
          { key: 'legacyObjectId', label: 'Legacy Object ID', detect: 'gdmsObjectId' },
          { key: 'legacyChronicleId', label: 'Legacy Chronicle ID', detect: 'gdmsChronicleId' },
          { key: 'productFamily', label: 'Product Family', detect: 'productFamily', kind: 'reference', wide: true },
          { key: 'createdDate', label: 'Created Date', field: 'document_creation_date__v', kind: 'date' },
          { key: 'modifiedDate', label: 'Modified Date', field: 'version_modified_date__v', kind: 'date' },
          { key: 'createdBy', label: 'Created By', field: 'created_by__v', kind: 'user' },
          { key: 'modifiedBy', label: 'Modified By', field: 'last_modified_by__v', kind: 'user' }
      ];
      // ---- Custom (user-defined) columns ----
      // Stored as [{ key: 'custom:<field>', label, field, custom: true }].
      // The column kind (date / user / reference / text) is inferred from the
      // Vault field metadata at lookup time.
      const FIND_CUSTOM_COLUMNS_KEY = 'ezFindByIdCustomColumns';
      // MVP custom search fields. Each rule maps a user-supplied regular expression
      // to a queryable Vault document field. Capture group 1 is used when present;
      // otherwise the full regex match is used. Rules are scoped to the current Vault.
      const FIND_CUSTOM_SEARCH_RULES_KEY = 'ezFindByIdCustomSearchRules';
      function getCustomSearchRules() {
          try {
              const all = JSON.parse(window.localStorage.getItem(FIND_CUSTOM_SEARCH_RULES_KEY) || '{}');
              const stored = all && Array.isArray(all[window.location.hostname]) ? all[window.location.hostname] : [];
              return stored.filter(r => r && typeof r.label === 'string' && typeof r.field === 'string' &&
                  typeof r.regex === 'string' && VAULT_FIELD_NAME.test(r.field)).map(r => ({
                      key: r.key || `customSearch:${r.field}`,
                      label: r.label.trim(), field: r.field.trim(), regex: r.regex, ignoreCase: r.ignoreCase !== false
                  }));
          } catch (error) { return []; }
      }
      function saveCustomSearchRules(rules) {
          let all = {};
          try { all = JSON.parse(window.localStorage.getItem(FIND_CUSTOM_SEARCH_RULES_KEY) || '{}') || {}; }
          catch (error) { all = {}; }
          all[window.location.hostname] = rules.map(r => ({
              key: r.key, label: r.label, field: r.field, regex: r.regex, ignoreCase: r.ignoreCase !== false
          }));
          window.localStorage.setItem(FIND_CUSTOM_SEARCH_RULES_KEY, JSON.stringify(all));
      }
      function addCustomSearchRule(label, field, regex, ignoreCase = true) {
          const cleanLabel = String(label || '').trim();
          const cleanField = String(field || '').trim();
          const cleanRegex = String(regex || '').trim();
          if (!cleanLabel) return 'A search-field label is required.';
          if (!VAULT_FIELD_NAME.test(cleanField)) return 'Enter a valid Vault document field API name.';
          if (cleanRegex) {
              try { new RegExp(cleanRegex, ignoreCase ? 'gi' : 'g'); }
              catch (error) { return `Invalid regular expression: ${error.message}`; }
          }
          const rules = getCustomSearchRules();
          if (rules.some(r => r.label.toLowerCase() === cleanLabel.toLowerCase())) return `A custom search field named "${cleanLabel}" already exists.`;
          if (rules.some(r => r.field.toLowerCase() === cleanField.toLowerCase())) return `The field ${cleanField} already has a custom search rule.`;
          rules.push({ key: `customSearch:${cleanField}`, label: cleanLabel, field: cleanField, regex: cleanRegex, ignoreCase });
          saveCustomSearchRules(rules);
          return null;
      }
      function deleteCustomSearchRule(key) {
          saveCustomSearchRules(getCustomSearchRules().filter(r => r.key !== key));
      }
      const VAULT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
      function getCustomFindColumns() {
          try {
              const stored = JSON.parse(window.localStorage.getItem(FIND_CUSTOM_COLUMNS_KEY) || '[]');
              if (!Array.isArray(stored)) return [];
              return stored
                  .filter(c => c && typeof c.label === 'string' && typeof c.field === 'string' && VAULT_FIELD_NAME.test(c.field))
                  .map(c => ({ key: `custom:${c.field}`, label: c.label, field: c.field, custom: true, wide: true }));
          } catch (error) {
              return [];
          }
      }
      function saveCustomFindColumns(columns) {
          window.localStorage.setItem(FIND_CUSTOM_COLUMNS_KEY,
              JSON.stringify(columns.map(c => ({ label: c.label, field: c.field }))));
      }
      // All optional columns: built-in first, then the user's custom columns.
      function getAllFindColumns() {
          const searchColumns = getCustomSearchRules().map(r => ({
              key: r.key, label: r.label, field: r.field, customSearch: true, wide: true
          }));
          return [...FIND_OPTIONAL_COLUMNS, ...getCustomFindColumns(), ...searchColumns];
      }
      // Validates and adds a custom column. Returns an error message or null.
      function addCustomFindColumn(label, field) {
          const cleanLabel = String(label || '').trim();
          const cleanField = String(field || '').trim();
          if (!cleanLabel) return 'A column label is required.';
          if (cleanLabel.length > 60) return 'The column label must be 60 characters or fewer.';
          if (!VAULT_FIELD_NAME.test(cleanField)) {
              return 'The Veeva field name may only contain letters, numbers and underscores (for example, my_field__c).';
          }
          const all = getAllFindColumns();
          const fixedLabels = ['input', 'type', 'result', 'matched on', 'document #', 'ver', 'latest?'];
          if (all.some(c => c.label.toLowerCase() === cleanLabel.toLowerCase()) || fixedLabels.includes(cleanLabel.toLowerCase())) {
              return `A column named "${cleanLabel}" already exists.`;
          }
          const existing = all.find(c => c.field && c.field.toLowerCase() === cleanField.toLowerCase());
          if (existing) return `The field ${cleanField} is already available as "${existing.label}".`;
          const custom = getCustomFindColumns();
          custom.push({ label: cleanLabel, field: cleanField });
          saveCustomFindColumns(custom);
          // Select the new column straight away.
          saveSelectedFindColumns([...getSelectedFindColumns(), `custom:${cleanField}`]);
          return null;
      }
      function deleteCustomFindColumn(key) {
          saveCustomFindColumns(getCustomFindColumns().filter(c => c.key !== key));
          saveSelectedFindColumns(getSelectedFindColumns().filter(k => k !== key));
      }
      function getSelectedFindColumns() {
          const all = getAllFindColumns();
          const defaults = all.filter(c => c.defaultOn).map(c => c.key);
          try {
              const stored = JSON.parse(window.localStorage.getItem(FIND_COLUMNS_KEY) || 'null');
              const forced = getCustomSearchRules().map(r => r.key);
              if (!Array.isArray(stored)) return [...new Set([...defaults, ...forced])];
              return all.map(c => c.key).filter(k => stored.includes(k) || forced.includes(k));
          } catch (error) {
              return defaults;
          }
      }
      function saveSelectedFindColumns(keys) {
          window.localStorage.setItem(FIND_COLUMNS_KEY, JSON.stringify(keys));
      }
      function getActiveFindColumns() {
          const selected = getSelectedFindColumns();
          return getAllFindColumns().filter(c => selected.includes(c.key));
      }
      // Document field metadata is reused by Find By ID, Related Documents, and
      // the Add Field picker. Persist the queryable properties in localStorage
      // so page navigation does not cause another metadata request. Users can
      // explicitly refresh the cache from the Add Field picker.
      const DOC_FIELD_META_CACHE_KEY = 'ezVeevaDocumentFieldMeta';
      const DOC_FIELD_META_CACHE_FORMAT = 1;
      let docFieldMetaCache = null;
      function buildDocFieldMeta(propertiesInput) {
          const properties = (propertiesInput || []).filter(p => p && p.name && p.queryable !== false);
          const byName = new Map(properties.map(p => [p.name, p]));
          const stringProps = properties.filter(p => !p.type || /string/i.test(p.type));
          const pick = (list, tests) => {
              for (const test of tests) {
                  const hit = list.find(p => test.test(`${p.label || ''} ${p.name}`));
                  if (hit) return hit.name;
              }
              return null;
          };
          const detected = {
              gdmsObjectId: pick(stringProps, [/legacy[^,]*object\s*_?id/i, /object[\s_]*id[^,]*legacy/i, /gdms[^,]*object/i, /legacy_object_id/i]),
              gdmsChronicleId: pick(stringProps, [/legacy[^,]*chronicle/i, /chronicle/i]),
              productFamily: pick(properties, [/^product\s*family\b/i, /product[\s_]*family/i])
          };
          return { properties, byName, detected };
      }
      function loadStoredDocFieldMeta() {
          try {
              const stored = JSON.parse(window.localStorage.getItem(DOC_FIELD_META_CACHE_KEY) || 'null');
              if (!stored || stored.format !== DOC_FIELD_META_CACHE_FORMAT ||
                  stored.hostname !== window.location.hostname ||
                  stored.apiVersion !== FIND_API_VERSION ||
                  !Array.isArray(stored.properties)) return null;
              return buildDocFieldMeta(stored.properties);
          } catch (error) {
              return null;
          }
      }
      function saveStoredDocFieldMeta(properties) {
          try {
              window.localStorage.setItem(DOC_FIELD_META_CACHE_KEY, JSON.stringify({
                  format: DOC_FIELD_META_CACHE_FORMAT,
                  hostname: window.location.hostname,
                  apiVersion: FIND_API_VERSION,
                  refreshedAt: new Date().toISOString(),
                  properties
              }));
          } catch (error) {
              console.warn('[EZ Veeva Helper] Could not cache document field metadata:', error);
          }
      }
      async function resolveDocFieldMeta(forceRefresh = false) {
          if (!forceRefresh && docFieldMetaCache) return docFieldMetaCache;
          if (!forceRefresh) {
              const stored = loadStoredDocFieldMeta();
              if (stored) {
                  docFieldMetaCache = stored;
                  return stored;
              }
          }
          const data = await vaultApi(`/api/${FIND_API_VERSION}/metadata/objects/documents/properties`);
          const properties = Array.isArray(data.properties) ? data.properties : [];
          saveStoredDocFieldMeta(properties);
          docFieldMetaCache = buildDocFieldMeta(properties);
          return docFieldMetaCache;
      }
      // Infers how to display a custom field from its Vault metadata.
      function inferColumnKind(prop) {
          if (!prop) return undefined;
          const type = String(prop.type || '');
          if (/date/i.test(type)) return 'date';
          if (/objectreference/i.test(type)) {
              const target = String(prop.objectType || (prop.object && prop.object.name) || '');
              return /^user(s|__sys)?$/i.test(target) ? 'user' : 'reference';
          }
          return undefined;
      }
      // Resolves the Vault field name and display kind behind every optional
      // column. Missing fields resolve to null so they never break the query.
      function resolveFindColumns(meta) {
          const columnFields = {};
          const columns = getAllFindColumns().map(col => {
              let name = null;
              if (col.detect) {
                  name = meta.detected[col.detect];
              } else if (meta.byName.has(col.field)) {
                  name = col.field;
              } else if (col.custom || col.customSearch) {
                  // Case-insensitive match for user-configured field names.
                  const lower = col.field.toLowerCase();
                  for (const key of meta.byName.keys()) {
                      if (key.toLowerCase() === lower) { name = key; break; }
                  }
              }
              columnFields[col.key] = name;
              const kind = (col.custom || col.customSearch) ? inferColumnKind(name && meta.byName.get(name)) : col.kind;
              return Object.assign({}, col, { kind });
          });
          return { columns, columnFields };
      }
      async function resolveGdmsFields() {
          const meta = await resolveDocFieldMeta();
          return { objectId: meta.detected.gdmsObjectId, chronicleId: meta.detected.gdmsChronicleId };
      }
      // Splits pasted text into tokens and classifies each one.
      // Returns { items: [{ input, type, key }], ignored: [token] }
      function parseFindInput(text) {
          const items = [];
          const ignored = [];
          const seen = new Set();
          const sourceText = String(text || '');
          const customRules = getCustomSearchRules();
          const explicitRules = customRules.filter(rule => Boolean(String(rule.regex || '').trim()));
          const fallbackRules = customRules.filter(rule => !String(rule.regex || '').trim());
          const add = (input, type, key, extra = {}) => {
              const dedupeKey = `${type}:${key}`;
              if (seen.has(dedupeKey)) return false;
              seen.add(dedupeKey);
              items.push(Object.assign({ input, type, key }, extra));
              return true;
          };
          const addCustom = (rule, extracted) => {
              const value = String(extracted || '').trim();
              if (!value) return false;
              const normalized = rule.ignoreCase !== false ? value.toLowerCase() : value;
              return add(value, rule.key, normalized, {
                  typeLabel: rule.label,
                  searchField: rule.field,
                  ignoreCase: rule.ignoreCase !== false
              });
          };
          const matchBuiltIn = token => {
              const linkMatch = token.match(VEEVA_ID_IN_LINK);
              if (linkMatch) { add(linkMatch[1], 'veevaId', linkMatch[1]); return true; }
              if (GDMS_ID_TOKEN.test(token)) { add(token.toLowerCase(), 'gdms', token.toLowerCase()); return true; }
              const gdmsInText = token.match(GDMS_ID_IN_TEXT);
              if (gdmsInText && /^https?:/i.test(token)) {
                  const id = gdmsInText[1].toLowerCase();
                  add(id, 'gdms', id);
                  return true;
              }
              if (/^https?:/i.test(token)) return false;
              if (VEEVA_ID_TOKEN.test(token)) { add(token, 'veevaId', token); return true; }
              if (isDocNumber(token)) {
                  const dn = token.toUpperCase();
                  add(dn, 'docNumber', dn.toLowerCase());
                  return true;
              }
              return false;
          };
          const matchExplicitCustom = token => {
              for (const rule of explicitRules) {
                  let matcher;
                  try { matcher = new RegExp(rule.regex, rule.ignoreCase !== false ? 'i' : ''); }
                  catch (error) { continue; }
                  const match = matcher.exec(token);
                  if (!match) continue;
                  const extracted = match[1] !== undefined ? match[1] : match[0];
                  addCustom(rule, extracted);
                  return true;
              }
              return false;
          };
          // Precedence is evaluated per non-empty input line:
          // built-in match > explicit custom regex match > every blank-regex fallback field.
          sourceText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => {
              const tokens = line.split(/[\s,;|]+/)
                  .map(token => token.trim().replace(/^["'(<\[]+|["')>\].]+$/g, ''))
                  .filter(Boolean);
              let lineHandled = false;
              for (const token of tokens) {
                  if (matchBuiltIn(token)) {
                      lineHandled = true;
                      continue;
                  }
                  if (matchExplicitCustom(token)) {
                      lineHandled = true;
                      continue;
                  }
                  // A blank-regex rule is intentionally a final fallback. If more than one
                  // exists, the otherwise-unrecognized token is searched on all of them.
                  if (fallbackRules.length && !/^https?:/i.test(token)) {
                      fallbackRules.forEach(rule => addCustom(rule, token));
                      lineHandled = true;
                  } else if (!fallbackRules.length) {
                      ignored.push(token);
                  }
              }
              // Explicit regexes may be intended for text containing spaces. If nothing
              // on the line matched at token level, give the complete line one chance.
              if (!lineHandled) {
                  if (matchExplicitCustom(line)) lineHandled = true;
                  else if (fallbackRules.length) {
                      fallbackRules.forEach(rule => addCustom(rule, line));
                      lineHandled = true;
                  }
              }
          });
          return { items, ignored };
      }
      function escapeVqlString(value) {
          return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      }
      async function runVql(query) {
          const rows = [];
          let data = await vaultApi(`/api/${FIND_API_VERSION}/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `q=${encodeURIComponent(query)}`
          });
          rows.push(...(data.data || []));
          let guard = 0;
          while (data.responseDetails && data.responseDetails.next_page && guard < 50) {
              data = await vaultApi(data.responseDetails.next_page);
              rows.push(...(data.data || []));
              guard += 1;
          }
          return rows;
      }
      function toValueList(value) {
          if (value === null || value === undefined || value === '') return [];
          if (Array.isArray(value)) return value.flatMap(toValueList);
          if (typeof value === 'object') {
              const inner = value.name__v || value.label || value.id;
              return inner === undefined ? [] : [String(inner)];
          }
          return [String(value)];
      }
      function formatVaultDate(value) {
          const text = toValueList(value)[0] || '';
          const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
          return match ? match[1] : text;
      }
      // Splits values into the fewest groups whose "prefix (v1, v2, ...)" text
      // stays within the VQL length budget.
      function chunkByLength(values, fixedLength) {
          const chunks = [];
          let current = [];
          let length = fixedLength;
          values.forEach(value => {
              const cost = value.length + 2; // value + ", "
              if (current.length && length + cost > VQL_MAX_LENGTH) {
                  chunks.push(current);
                  current = [];
                  length = fixedLength;
              }
              current.push(value);
              length += cost;
          });
          if (current.length) chunks.push(current);
          return chunks;
      }
      // Looks up display names for record / user IDs. Falls back to the raw IDs.
      async function lookupNames(objectNames, ids, numeric) {
          const names = new Map();
          const unique = [...new Set(ids.filter(Boolean))];
          const literals = numeric
              ? unique.filter(id => /^\d+$/.test(id))
              : unique.map(id => `'${escapeVqlString(id)}'`);
          if (!literals.length) return names;
          for (const objectName of objectNames) {
              try {
                  const prefix = `SELECT id, name__v FROM ${objectName} WHERE id CONTAINS ()`;
                  for (const chunk of chunkByLength(literals, prefix.length)) {
                      const rows = await runVql(`SELECT id, name__v FROM ${objectName} WHERE id CONTAINS (${chunk.join(', ')})`);
                      rows.forEach(row => names.set(String(row.id), row.name__v || String(row.id)));
                  }
                  return names;
              } catch (error) {
                  console.warn(`[EZ Veeva Helper] Name lookup on ${objectName} failed:`, error);
              }
          }
          return names;
      }
      // Builds the WHERE clause for a batch using one CONTAINS list per field:
      //   id CONTAINS (...) OR document_number__v CONTAINS (...) OR <gdms field> CONTAINS (...)
      function buildFindWhere(batch, gdmsFields) {
          const ids = [];
          const docNumbers = [];
          const gdmsIds = [];
          batch.forEach(item => {
              if (item.type === 'veevaId') ids.push(item.key);                       // digits only
              else if (item.type === 'docNumber') docNumbers.push(`'${escapeVqlString(item.input)}'`);
              else if (item.type === 'gdms') gdmsIds.push(`'${item.key}'`);          // validated hex
          });
          const clauses = [];
          if (ids.length) clauses.push(`id CONTAINS (${ids.join(', ')})`);
          if (docNumbers.length) clauses.push(`document_number__v CONTAINS (${docNumbers.join(', ')})`);
          if (gdmsIds.length) gdmsFields.forEach(f => clauses.push(`${f} CONTAINS (${gdmsIds.join(', ')})`));
          const customGroups = new Map();
          batch.filter(item => item.searchField).forEach(item => {
              if (!customGroups.has(item.searchField)) customGroups.set(item.searchField, []);
              customGroups.get(item.searchField).push(`'${escapeVqlString(item.input)}'`);
          });
          customGroups.forEach((values, field) => clauses.push(`${field} CONTAINS (${values.join(', ')})`));
          return clauses.join(' OR ');
      }
      // Packs items into the fewest batches whose full query fits VQL_MAX_LENGTH.
      // Each item's cost is the length it adds to the query, including the
      // first-use cost of its CONTAINS clause.
      function batchFindItemsByLength(items, baseLength, gdmsFields) {
          // Conservative incremental packing. Rebuild the candidate WHERE clause
          // so custom fields are included in the same 45K safety limit.
          const batches = [];
          let current = [];
          items.forEach(item => {
              const candidate = [...current, item];
              const candidateLength = baseLength + buildFindWhere(candidate, gdmsFields).length;
              if (current.length && candidateLength > VQL_MAX_LENGTH) {
                  batches.push(current);
                  current = [item];
              } else {
                  current = candidate;
              }
          });
          if (current.length) batches.push(current);
          return batches;
      }
      async function findDocumentsById(items, allVersions, onProgress) {
          const meta = await resolveDocFieldMeta();
          const { columns: allColumns, columnFields } = resolveFindColumns(meta);
          const fields = { objectId: meta.detected.gdmsObjectId, chronicleId: meta.detected.gdmsChronicleId };
          const missingCustomSearchFields = getCustomSearchRules().filter(r => !meta.byName.has(r.field));
          if (missingCustomSearchFields.length) {
              throw new Error(`Custom search field not found or not queryable in this Vault: ${missingCustomSearchFields.map(r => r.field).join(', ')}`);
          }
          const hasGdms = items.some(i => i.type === 'gdms');
          if (hasGdms && !fields.objectId && !fields.chronicleId) {
              throw new Error('Could not detect the legacy GDMS Object ID / Chronicle ID fields in this Vault.');
          }
          const fromClause = allVersions ? 'ALLVERSIONS documents' : 'documents';
          const gdmsFields = [fields.objectId, fields.chronicleId].filter(Boolean);
          // Always fetch every available optional field so columns can be toggled
          // after a lookup without re-running it.
          const customSearchFields = getCustomSearchRules().map(r => r.field).filter(f => meta.byName.has(f));
          const optionalFields = Object.values(columnFields).filter(Boolean);
          const select = [...new Set(['id', 'document_number__v', 'name__v', 'major_version_number__v',
              'minor_version_number__v', 'status__v', 'latest_version__v', ...gdmsFields, ...customSearchFields, ...optionalFields])];
          // hits keyed by "type:key"
          const hits = new Map(items.map(i => [`${i.type}:${i.key}`, []]));
          const pushHit = (mapKey, matchType, row) => {
              if (!hits.has(mapKey)) return;
              const list = hits.get(mapKey);
              const rowKey = `${row.id}/${row.major_version_number__v}/${row.minor_version_number__v}`;
              if (list.some(h => h.rowKey === rowKey)) return;
              list.push({ matchType, row, rowKey });
          };
          // Only items that can be queried (GDMS items need a GDMS field).
          const queryable = items.filter(i => i.type !== 'gdms' || gdmsFields.length);
          const baseQuery = `SELECT ${select.join(', ')} FROM ${fromClause} WHERE `;
          const batches = batchFindItemsByLength(queryable, baseQuery.length, gdmsFields);
          let done = 0;
          for (let b = 0; b < batches.length; b += 1) {
              const batch = batches[b];
              const query = baseQuery + buildFindWhere(batch, gdmsFields);
              if (query.length > VQL_MAX_LENGTH) {
                  // Safety net: should never happen, but never send an oversized query.
                  throw new Error(`Internal error: query batch exceeded ${VQL_MAX_LENGTH} characters.`);
              }
              const rows = await runVql(query);
              rows.forEach(row => {
                  const idText = String(row.id);
                  const docNumber = String(row.document_number__v || '').toLowerCase();
                  pushHit(`veevaId:${idText}`, 'Veeva ID', row);
                  pushHit(`docNumber:${docNumber}`, 'Document #', row);
                  if (fields.objectId) {
                      pushHit(`gdms:${String(row[fields.objectId] || '').toLowerCase()}`, 'GDMS Object ID', row);
                  }
                  if (fields.chronicleId) {
                      pushHit(`gdms:${String(row[fields.chronicleId] || '').toLowerCase()}`, 'GDMS Chronicle ID', row);
                  }
                  getCustomSearchRules().forEach(rule => {
                      toValueList(row[rule.field]).forEach(value => {
                          const normalized = rule.ignoreCase !== false ? String(value).toLowerCase() : String(value);
                          pushHit(`${rule.key}:${normalized}`, rule.label, row);
                      });
                  });
              });
              done += batch.length;
              if (onProgress) onProgress(done, queryable.length, b + 1, batches.length);
          }
          // Results are assembled by walking the ORIGINAL input list, so the
          // report always follows the order the values were pasted in, no
          // matter how the batches were packed or what order Vault returned rows.
          const results = [];
          items.forEach(item => {
              const list = hits.get(`${item.type}:${item.key}`);
              const inputType = item.typeLabel || INPUT_TYPE_LABELS[item.type] || item.type;
              if (!list.length) {
                  results.push({ input: item.input, inputType, found: false, extra: {} });
                  return;
              }
              list.sort((a, b) =>
                  (String(a.row.id) === String(b.row.id) ? 0 : (a.row.id - b.row.id)) ||
                  (b.row.major_version_number__v - a.row.major_version_number__v) ||
                  (b.row.minor_version_number__v - a.row.minor_version_number__v));
              list.forEach(hit => {
                  const r = hit.row;
                  results.push({
                      input: item.input,
                      inputType,
                      found: true,
                      matchType: hit.matchType,
                      veevaId: String(r.id),
                      docNumber: r.document_number__v || '',
                      version: `${r.major_version_number__v}.${r.minor_version_number__v}`,
                      latest: r.latest_version__v === true || String(r.latest_version__v).toLowerCase() === 'true',
                      url: `${window.location.origin}/ui/#doc_info/${r.id}/${r.major_version_number__v}/${r.minor_version_number__v}`,
                      raw: r,
                      extra: {}
                  });
              });
          });
          // Resolve user and object-reference IDs to names.
          const found = results.filter(r => r.found);
          const collect = kind => allColumns
              .filter(c => c.kind === kind && columnFields[c.key])
              .flatMap(c => found.flatMap(r => toValueList(r.raw[columnFields[c.key]])));
          const userNames = await lookupNames(['user__sys'], collect('user'), true);
          const referenceNames = new Map();
          for (const col of allColumns.filter(c => c.kind === 'reference' && columnFields[c.key])) {
              const prop = meta.byName.get(columnFields[col.key]);
              const objectName = prop && (prop.objectType || (prop.object && prop.object.name));
              if (!objectName) continue;
              const ids = found.flatMap(r => toValueList(r.raw[columnFields[col.key]]));
              (await lookupNames([objectName], ids, false)).forEach((v, k) => referenceNames.set(k, v));
          }
          found.forEach(r => {
              allColumns.forEach(col => {
                  const field = columnFields[col.key];
                  if (!field) { r.extra[col.key] = ''; return; }
                  const value = r.raw[field];
                  if (col.kind === 'date') {
                      r.extra[col.key] = formatVaultDate(value);
                  } else if (col.kind === 'user') {
                      r.extra[col.key] = toValueList(value).map(id => userNames.get(id) || id).join(', ');
                  } else if (col.kind === 'reference') {
                      r.extra[col.key] = toValueList(value).map(id => referenceNames.get(id) || id).join(', ');
                  } else {
                      r.extra[col.key] = toValueList(value).join(', ');
                  }
              });
              delete r.raw;
          });
          return { results, unavailable: allColumns.filter(c => !columnFields[c.key]).map(c => c.label) };
      }
      function findResultsToTsv(results, mode) {
          if (mode === 'related') return relatedResultsToTsv(results);
          const optional = getActiveFindColumns();
          const header = ['Input', 'Input Type', 'Result', 'Matched On', 'Veeva ID', 'Document #', 'Version', 'Latest?',
              ...optional.map(c => c.label), 'URL'];
          const clean = v => String(v || '').replace(/[\t\r\n]+/g, ' ');
          const lines = results.map(r => [
              r.input, r.inputType || '',
              r.found ? 'Found' : 'Not visible to me',
              r.matchType || '', r.veevaId || '', r.docNumber || '', r.version || '',
              r.found ? (r.latest ? 'Yes' : 'No') : '',
              ...optional.map(c => clean((r.extra || {})[c.key])),
              r.url || ''
          ].map(clean).join('\t'));
          return [header.join('\t'), ...lines].join('\r\n');
      }
      function makeEzButton(text, primary) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = text;
          b.style.cssText = primary
              ? 'padding:5px 14px;cursor:pointer;background:#174ea6;border:1px solid #174ea6;border-radius:3px;color:#fff;font-weight:600;'
              : 'padding:5px 12px;cursor:pointer;background:#f3f3f3;border:1px solid #c8c8c8;border-radius:3px;color:#222;';
          return b;
      }
      function flashButton(button, text) {
          const original = button.textContent;
          button.textContent = text;
          window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 2000);
      }
      // Dialog title bar with a small close (X) button at the top right.
      // isBusy() blocks closing while a lookup is running, like the Close button.
      function makeDialogHeader(titleId, titleText, onClose, isBusy) {
          const header = document.createElement('div');
          header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;min-height:42px;box-sizing:border-box;background:#174ea6;color:#fff;font-weight:700;font-size:14px;';
          const title = document.createElement('span');
          title.id = titleId;
          title.textContent = titleText;
          title.style.cssText = 'flex:1 1 auto;';
          const x = document.createElement('button');
          x.type = 'button';
          x.title = 'Close';
          x.setAttribute('aria-label', 'Close');
          x.style.cssText = 'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:#fff;cursor:pointer;';
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('width', '12');
          svg.setAttribute('height', '12');
          svg.setAttribute('viewBox', '0 0 12 12');
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('focusable', 'false');
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', 'M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5');
          path.setAttribute('stroke', 'currentColor');
          path.setAttribute('stroke-width', '1.8');
          path.setAttribute('stroke-linecap', 'round');
          svg.appendChild(path);
          x.appendChild(svg);
          x.addEventListener('mouseenter', () => { if (!isBusy()) x.style.background = 'rgba(255,255,255,0.18)'; });
          x.addEventListener('mouseleave', () => { x.style.background = 'transparent'; });
          x.addEventListener('click', event => {
              event.preventDefault();
              event.stopPropagation();
              if (isBusy()) {
                  x.title = 'Please wait until the lookup finishes';
                  return;
              }
              onClose();
          });
          header.append(title, x);
          return header;
      }
      function closeFindByIdDialog() {
          const overlay = document.getElementById('ez-find-by-id-overlay');
          if (overlay) overlay.remove();
      }
      function makeDocLink(r) {
          if (!r.found) return '';
          const link = document.createElement('a');
          link.href = r.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = r.docNumber || r.veevaId || 'Open';
          link.title = `Veeva ID ${r.veevaId}`;
          return link;
      }
      // Fixed (always shown) columns. cell(r) returns text or a Node;
      // style(r) returns extra inline CSS for the cell.
      const RESULT_COLUMN = {
          label: 'Result',
          cell: r => (r.found ? 'Found' : 'Not visible to me'),
          style: r => `color:${r.found ? '#137333' : '#b06000'};`
      };
      const LATEST_COLUMN = {
          label: 'Latest?',
          cell: r => (r.found ? (r.latest ? 'Yes' : 'No') : ''),
          style: r => (r.found ? `font-weight:${r.latest ? '600' : 'normal'};color:${r.latest ? '#137333' : '#666'};` : '')
      };
      const FIND_FIXED_COLUMNS = [
          { label: 'Input', cell: r => r.input },
          { label: 'Type', cell: r => r.inputType || '', style: () => 'color:#555;' },
          RESULT_COLUMN,
          { label: 'Matched On', cell: r => r.matchType || '' },
          { label: 'Document #', cell: makeDocLink },
          { label: 'Ver', cell: r => r.version || '' },
          LATEST_COLUMN
      ];
      const RELATED_FIXED_COLUMNS = [
          { label: 'Relationship', cell: r => r.relationship || '', style: () => 'font-weight:600;' },
          { label: 'Direction', cell: r => r.direction || '', style: () => 'color:#555;' },
          { label: 'Related To', cell: r => r.boundTo || '', style: () => 'color:#555;' },
          { label: 'Veeva ID', cell: r => r.relatedId || '' },
          RESULT_COLUMN,
          { label: 'Document #', cell: makeDocLink },
          { label: 'Ver', cell: r => r.version || '' },
          LATEST_COLUMN
      ];
      function renderFindResults(container, results, fixedColumns = FIND_FIXED_COLUMNS) {
          container.replaceChildren();
          if (!results.length) return;
          const optional = getActiveFindColumns();
          const table = document.createElement('table');
          table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
          const head = document.createElement('tr');
          [...fixedColumns.map(c => c.label), ...optional.map(c => c.label)].forEach(h => {
              const th = document.createElement('th');
              th.textContent = h;
              th.style.cssText = 'position:sticky;top:0;background:#eef3fb;text-align:left;padding:4px 6px;border-bottom:1px solid #c8d4e8;white-space:nowrap;';
              head.appendChild(th);
          });
          table.appendChild(head);
          const cellStyle = 'padding:3px 6px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;';
          const addCell = (tr, value, extraStyle) => {
              const td = document.createElement('td');
              td.style.cssText = cellStyle + (extraStyle || '');
              if (value instanceof Node) td.appendChild(value); else td.textContent = value || '';
              tr.appendChild(td);
              return td;
          };
          results.forEach(r => {
              const tr = document.createElement('tr');
              tr.style.cssText = r.found ? '' : 'background:#fff4ce;';
              // Fixed columns
              fixedColumns.forEach(col => addCell(tr, col.cell(r), col.style ? col.style(r) : ''));
              // Optional columns
              optional.forEach(col => {
                  const value = (r.extra || {})[col.key] || '';
                  const td = addCell(tr, value, col.wide ? 'max-width:240px;overflow:hidden;text-overflow:ellipsis;' : '');
                  if (col.wide && value) td.title = value;
              });
              table.appendChild(tr);
          });
          container.appendChild(table);
      }
      // Column picker panel shown inside the Find By ID dialog.
      function buildFindColumnPicker(onChange, fixedLabels = FIND_FIXED_COLUMNS.map(c => c.label)) {
          const panel = document.createElement('div');
          panel.style.cssText = 'display:none;padding:8px 10px;border:1px solid #c8d4e8;border-radius:6px;background:#fbfdff;font-size:12px;';
          const title = document.createElement('div');
          title.style.cssText = 'font-weight:700;color:#174ea6;margin-bottom:6px;';
          title.textContent = 'Report columns';
          const grid = document.createElement('div');
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(4, minmax(150px, 1fr));gap:4px 12px;';
          const makeBox = (labelText, checked, locked, key) => {
              const label = document.createElement('label');
              label.style.cssText = `display:inline-flex;align-items:center;gap:5px;margin:0;font-weight:normal;cursor:${locked ? 'default' : 'pointer'};color:${locked ? '#888' : '#222'};`;
              const box = document.createElement('input');
              box.type = 'checkbox';
              box.checked = checked;
              box.disabled = locked;
              box.style.cssText = 'width:14px;height:14px;margin:0;';
              if (key) box.dataset.columnKey = key;
              const span = document.createElement('span');
              span.textContent = labelText;
              label.append(box, span);
              if (locked) label.title = 'Always included';
              return label;
          };
          fixedLabels.forEach(h => grid.appendChild(makeBox(h, true, true)));
          const fixedCount = grid.children.length;
          const renderOptionalBoxes = () => {
              while (grid.children.length > fixedCount) grid.lastChild.remove();
              const selected = getSelectedFindColumns();
              getAllFindColumns().forEach(col => {
                  const label = makeBox(col.label, selected.includes(col.key), Boolean(col.customSearch), col.key);
                  if (col.custom || col.customSearch) {
                      label.title = col.customSearch ? `Custom search field: ${col.field} (always included)` : `Custom column: ${col.field}`;
                      label.querySelector('span').style.fontStyle = 'italic';
                      const del = document.createElement('button');
                      del.type = 'button';
                      del.textContent = '\u2715';
                      del.title = `Delete custom column "${col.label}"`;
                      del.setAttribute('aria-label', `Delete custom column ${col.label}`);
                      del.style.cssText = 'margin-left:2px;padding:0 3px;border:0;background:transparent;color:#b3261e;cursor:pointer;font-size:11px;line-height:1;';
                      // Inline confirmation: the ✕ is replaced by "Delete? Yes / No".
                      const confirmBox = document.createElement('span');
                      confirmBox.style.cssText = 'display:none;align-items:center;gap:4px;margin-left:4px;font-size:11px;color:#b3261e;white-space:nowrap;';
                      const confirmText = document.createElement('span');
                      confirmText.textContent = 'Delete?';
                      const linkStyle = 'padding:0 2px;border:0;background:transparent;cursor:pointer;font-size:11px;text-decoration:underline;';
                      const yes = document.createElement('button');
                      yes.type = 'button';
                      yes.textContent = 'Yes';
                      yes.style.cssText = linkStyle + 'color:#b3261e;font-weight:600;';
                      const no = document.createElement('button');
                      no.type = 'button';
                      no.textContent = 'No';
                      no.style.cssText = linkStyle + 'color:#174ea6;';
                      confirmBox.append(confirmText, yes, no);
                      const stop = event => { event.preventDefault(); event.stopPropagation(); };
                      del.addEventListener('click', event => {
                          stop(event);
                          del.style.display = 'none';
                          confirmBox.style.display = 'inline-flex';
                      });
                      no.addEventListener('click', event => {
                          stop(event);
                          confirmBox.style.display = 'none';
                          del.style.display = '';
                      });
                      yes.addEventListener('click', event => {
                          stop(event);
                          col.customSearch ? deleteCustomSearchRule(col.key) : deleteCustomFindColumn(col.key);
                          renderOptionalBoxes();
                          onChange();
                          unavailable.textContent = `${col.customSearch ? 'Custom search field' : 'Custom column'} "${col.label}" deleted.`;
                      });
                      label.append(del, confirmBox);
                  }
                  grid.appendChild(label);
              });
          };
          renderOptionalBoxes();
          grid.addEventListener('change', () => {
              const keys = Array.from(grid.querySelectorAll('input[data-column-key]'))
                  .filter(b => b.checked).map(b => b.dataset.columnKey);
              saveSelectedFindColumns(keys);
              onChange();
          });
          const footer = document.createElement('div');
          footer.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:8px;';
          const reset = document.createElement('button');
          reset.type = 'button';
          reset.textContent = 'Reset to default';
          reset.style.cssText = 'padding:0;border:0;background:transparent;color:#174ea6;cursor:pointer;text-decoration:underline;font-size:12px;';
          reset.addEventListener('click', () => {
              const defaults = getAllFindColumns().filter(c => c.defaultOn).map(c => c.key);
              grid.querySelectorAll('input[data-column-key]').forEach(b => { b.checked = defaults.includes(b.dataset.columnKey); });
              saveSelectedFindColumns(defaults);
              onChange();
          });
          const addCustom = document.createElement('button');
          addCustom.type = 'button';
          addCustom.textContent = '+ Add custom column';
          addCustom.title = 'Add a Vault document field that is not in the list';
          addCustom.style.cssText = reset.style.cssText;
          const addSearch = document.createElement('button');
          addSearch.type = 'button';
          addSearch.textContent = '+ Add custom search field';
          addSearch.title = 'Map a regular expression to a queryable Vault document field. Capture group 1 is used when present.';
          addSearch.style.cssText = reset.style.cssText;
          const unavailable = document.createElement('span');
          unavailable.style.cssText = 'color:#b06000;';
          footer.append(reset, addCustom, addSearch, unavailable);
          // ---- Metadata-backed Add Field picker ---------------------------
          const form = document.createElement('div');
          form.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-top:8px;padding:8px;border:1px dashed #c8d4e8;border-radius:4px;background:#ffffff;';
          const pickerTop = document.createElement('div');
          pickerTop.style.cssText = 'display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;';
          const searchWrap = document.createElement('label');
          searchWrap.style.cssText = 'display:flex;flex:1 1 280px;flex-direction:column;gap:2px;margin:0;font-weight:normal;font-size:11px;color:#444;';
          const searchCaption = document.createElement('span');
          searchCaption.textContent = 'Search available document fields';
          const fieldSearch = document.createElement('input');
          fieldSearch.type = 'search';
          fieldSearch.placeholder = 'Search by field label or API name';
          fieldSearch.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid #c8c8c8;border-radius:3px;';
          searchWrap.append(searchCaption, fieldSearch);
          const refreshFields = makeEzButton('Refresh fields');
          refreshFields.title = 'Discard the locally cached field list and reload it from Vault';
          refreshFields.style.padding = '4px 10px';
          pickerTop.append(searchWrap, refreshFields);
          const fieldList = document.createElement('select');
          fieldList.size = 8;
          fieldList.setAttribute('aria-label', 'Available document fields');
          fieldList.style.cssText = 'width:100%;min-height:150px;padding:3px;font-family:Arial,Helvetica,sans-serif;font-size:12px;border:1px solid #c8c8c8;border-radius:3px;';
          const pickerStatus = document.createElement('div');
          pickerStatus.setAttribute('role', 'status');
          pickerStatus.style.cssText = 'color:#666;font-size:11px;min-height:14px;';
          const pickerActions = document.createElement('div');
          pickerActions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
          const saveCustom = makeEzButton('Add Selected', true);
          saveCustom.disabled = true;
          const cancelCustom = makeEzButton('Cancel');
          pickerActions.append(cancelCustom, saveCustom);
          form.append(pickerTop, fieldList, pickerStatus, pickerActions);
          let availableFieldChoices = [];
          const renderFieldChoices = () => {
              const term = fieldSearch.value.trim().toLowerCase();
              const filtered = availableFieldChoices.filter(field =>
                  !term || field.label.toLowerCase().includes(term) || field.name.toLowerCase().includes(term));
              fieldList.replaceChildren();
              filtered.forEach(field => {
                  const option = document.createElement('option');
                  option.value = field.name;
                  option.textContent = `${field.label} - ${field.name}${field.type ? ` (${field.type})` : ''}`;
                  option.title = option.textContent;
                  fieldList.appendChild(option);
              });
              saveCustom.disabled = !fieldList.value;
              pickerStatus.textContent = `${filtered.length.toLocaleString('en-US')} available field${filtered.length === 1 ? '' : 's'}` +
                  (term ? ` matching "${fieldSearch.value.trim()}"` : '');
          };
          const loadFieldChoices = async forceRefresh => {
              fieldSearch.disabled = true;
              fieldList.disabled = true;
              refreshFields.disabled = true;
              saveCustom.disabled = true;
              pickerStatus.textContent = forceRefresh ? 'Refreshing fields from Vault...' : 'Loading available fields...';
              try {
                  const meta = await resolveDocFieldMeta(forceRefresh);
                  const existingFields = new Set(getAllFindColumns()
                      .filter(c => c.field)
                      .map(c => c.field.toLowerCase()));
                  availableFieldChoices = meta.properties
                      .filter(prop => !existingFields.has(prop.name.toLowerCase()))
                      .map(prop => ({
                          name: prop.name,
                          label: String(prop.label || prop.name),
                          type: String(prop.type || '')
                      }))
                      .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
                  renderFieldChoices();
                  if (forceRefresh) unavailable.textContent = 'Available fields refreshed from Vault.';
              } catch (error) {
                  availableFieldChoices = [];
                  fieldList.replaceChildren();
                  pickerStatus.textContent = `Could not load fields: ${error.message}`;
              } finally {
                  fieldSearch.disabled = false;
                  fieldList.disabled = false;
                  refreshFields.disabled = false;
                  saveCustom.disabled = !fieldList.value;
              }
          };
          const showForm = open => {
              form.style.display = open ? 'flex' : 'none';
              addCustom.style.display = open ? 'none' : '';
              if (open) {
                  fieldSearch.value = '';
                  loadFieldChoices(false).then(() => fieldSearch.focus());
              }
          };
          const submitSelectedField = () => {
              const selected = availableFieldChoices.find(field => field.name === fieldList.value);
              if (!selected) {
                  pickerStatus.textContent = 'Select a field to add.';
                  return;
              }
              const error = addCustomFindColumn(selected.label, selected.name);
              if (error) {
                  pickerStatus.textContent = error;
                  return;
              }
              showForm(false);
              renderOptionalBoxes();
              onChange();
              unavailable.textContent = `Field "${selected.label}" added. Run Find again to load its values.`;
          };
          addCustom.addEventListener('click', () => showForm(true));
          cancelCustom.addEventListener('click', () => showForm(false));
          refreshFields.addEventListener('click', () => loadFieldChoices(true));
          fieldSearch.addEventListener('input', renderFieldChoices);
          fieldList.addEventListener('change', () => { saveCustom.disabled = !fieldList.value; });
          fieldList.addEventListener('dblclick', submitSelectedField);
          saveCustom.addEventListener('click', submitSelectedField);
          fieldSearch.addEventListener('keydown', event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); showForm(false); }
          });
          const searchForm = document.createElement('div');
          searchForm.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-top:8px;padding:8px;border:1px dashed #8fb0e6;border-radius:4px;background:#f8fbff;';
          const sfSearch = document.createElement('input');
          sfSearch.type = 'search';
          sfSearch.placeholder = 'Search by field label or API name';
          sfSearch.style.cssText = fieldSearch.style.cssText;
          const sfList = document.createElement('select');
          sfList.size = 6;
          sfList.style.cssText = fieldList.style.cssText;
          const regexLabel = document.createElement('label');
          regexLabel.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin:0;font-weight:normal;font-size:11px;color:#444;';
          const regexCaption = document.createElement('span');
          regexCaption.textContent = 'Regex (optional)';
          const regexInput = document.createElement('input');
          regexInput.type = 'text';
          regexInput.placeholder = 'Blank = fallback for values not recognized by higher-priority rules';
          regexInput.style.cssText = fieldSearch.style.cssText + 'font-family:Consolas,monospace;';
          regexLabel.append(regexCaption, regexInput);
          const sfStatus = document.createElement('div');
          sfStatus.style.cssText = 'font-size:11px;color:#666;min-height:14px;';
          const sfActions = document.createElement('div');
          sfActions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
          const sfCancel = makeEzButton('Cancel');
          const sfAdd = makeEzButton('Add Field', true);
          sfAdd.disabled = true;
          sfActions.append(sfCancel, sfAdd);
          searchForm.append(sfSearch, sfList, regexLabel, sfStatus, sfActions);
          let sfChoices = [];
          const validateSf = () => {
              const regex = regexInput.value.trim();
              if (!regex) {
                  sfStatus.textContent = 'Fallback field. Used only when the value matches neither a built-in rule nor an explicit custom regex.';
                  sfStatus.style.color = '#666';
                  return true;
              }
              try {
                  new RegExp(regex, 'i');
                  sfStatus.textContent = 'Explicit regex. Evaluated after built-in rules and before blank-regex fallback fields.';
                  sfStatus.style.color = '#137333';
                  return true;
              } catch (error) {
                  sfStatus.textContent = `Invalid regex: ${error.message}`;
                  sfStatus.style.color = '#b3261e';
                  return false;
              }
          };
          const renderSfChoices = () => {
              const term = sfSearch.value.trim().toLowerCase();
              const prior = sfList.value;
              const filtered = sfChoices.filter(field => !term || field.label.toLowerCase().includes(term) || field.name.toLowerCase().includes(term));
              sfList.replaceChildren();
              filtered.forEach(field => {
                  const option = document.createElement('option');
                  option.value = field.name;
                  option.textContent = `${field.label} - ${field.name}${field.type ? ` (${field.type})` : ''}`;
                  sfList.appendChild(option);
              });
              if (prior && filtered.some(field => field.name === prior)) sfList.value = prior;
              sfAdd.disabled = !sfList.value || !validateSf();
          };
          const showSearchForm = async open => {
              searchForm.style.display = open ? 'flex' : 'none';
              addSearch.style.display = open ? 'none' : '';
              if (!open) return;
              sfSearch.value = '';
              regexInput.value = '';
              sfStatus.textContent = 'Loading available fields...';
              try {
                  const meta = await resolveDocFieldMeta(false);
                  const used = new Set(getCustomSearchRules().map(rule => rule.field.toLowerCase()));
                  sfChoices = meta.properties
                      .filter(prop => !used.has(prop.name.toLowerCase()))
                      .map(prop => ({ name: prop.name, label: String(prop.label || prop.name), type: String(prop.type || '') }))
                      .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
                  renderSfChoices();
                  sfSearch.focus();
              } catch (error) {
                  sfChoices = [];
                  sfList.replaceChildren();
                  sfStatus.textContent = `Could not load fields: ${error.message}`;
                  sfStatus.style.color = '#b3261e';
              }
          };
          const submitSearchField = () => {
              const selected = sfChoices.find(field => field.name === sfList.value);
              if (!selected) { sfStatus.textContent = 'Select a field to add.'; return; }
              if (!validateSf()) return;
              const error = addCustomSearchRule(selected.label, selected.name, regexInput.value.trim(), true);
              if (error) { sfStatus.textContent = error; sfStatus.style.color = '#b3261e'; return; }
              showSearchForm(false);
              renderOptionalBoxes();
              onChange();
              unavailable.textContent = `Search field "${selected.label}" added. It will be searched and included in results.`;
          };
          addSearch.addEventListener('click', () => showSearchForm(true));
          sfCancel.addEventListener('click', () => showSearchForm(false));
          sfSearch.addEventListener('input', renderSfChoices);
          sfList.addEventListener('change', renderSfChoices);
          regexInput.addEventListener('input', renderSfChoices);
          sfList.addEventListener('dblclick', submitSearchField);
          sfAdd.addEventListener('click', submitSearchField);
          panel.append(title, grid, footer, form, searchForm);
          return {
              panel,
              setUnavailable(labels) {
                  unavailable.textContent = labels.length ? `Not available in this Vault: ${labels.join(', ')}` : '';
              }
          };
      }
      function openFindByIdDialog() {
          if (!hasApiAccess()) {
              alert('API access has not been confirmed. Open EZ settings and select Check API access.');
              return;
          }
          if (document.getElementById('ez-find-by-id-overlay')) return;
          const overlay = document.createElement('div');
          overlay.id = 'ez-find-by-id-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,0.35);display:flex;align-items:flex-start;justify-content:center;padding-top:70px;';
          // The dialog only closes via the Close button (no background click / Escape).
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-modal', 'true');
          dialog.setAttribute('aria-labelledby', 'ez-find-by-id-title');
          dialog.style.cssText = 'width:940px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#222;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.3);font-size:13px;overflow:hidden;';
          const header = makeDialogHeader('ez-find-by-id-title', 'EZ Find By ID',
              closeFindByIdDialog, () => findLookupActive);
          const body = document.createElement('div');
          body.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;overflow:hidden;flex:1 1 auto;min-height:0;';
          const hint = document.createElement('div');
          hint.style.cssText = 'color:#555;font-size:12px;';
          hint.textContent = `Paste Veeva document IDs (numbers), document numbers (PFE-RIM-<type>-########), ` +
              `GDMS IDs or Links. Separate with new lines, spaces, ` +
              `commas or semicolons (up to ${FIND_MAX_IDS}). Values that don't match are ignored.`;
          const input = document.createElement('textarea');
          input.rows = 5;
          input.placeholder = 'Paste values here';
          input.style.cssText = 'width:100%;box-sizing:border-box;font-family:Consolas,monospace;font-size:12px;padding:6px;border:1px solid #c8c8c8;border-radius:4px;resize:vertical;';
          const counter = document.createElement('span');
          counter.style.cssText = 'color:#555;font-size:12px;';
          const updateCounter = () => {
              const { items, ignored } = parseFindInput(input.value);
              const n = items.length;
              const byType = type => items.filter(i => i.type === type).length;
              const parts = [];
              if (byType('veevaId')) parts.push(`${byType('veevaId')} Veeva ID`);
              if (byType('docNumber')) parts.push(`${byType('docNumber')} Doc #`);
              if (byType('gdms')) parts.push(`${byType('gdms')} GDMS`);
              getCustomSearchRules().forEach(rule => {
                  const count = items.filter(i => i.type === rule.key).length;
                  if (count) parts.push(`${count} ${rule.label}`);
              });
              counter.textContent = `${n} unique ID${n === 1 ? '' : 's'} detected` +
                  (parts.length ? ` (${parts.join(', ')})` : '') +
                  (ignored.length ? ` \u2022 ${ignored.length} ignored` : '');
              counter.title = ignored.length ? `Ignored (no matching pattern): ${ignored.slice(0, 20).join(', ')}${ignored.length > 20 ? ', \u2026' : ''}` : '';
              if (n > FIND_MAX_IDS) counter.textContent += ` \u2022 only the first ${FIND_MAX_IDS} will be searched`;
              counter.style.color = n > FIND_MAX_IDS ? '#b3261e' : (ignored.length ? '#b06000' : '#555');
          };
          input.addEventListener('input', updateCounter);
          input.addEventListener('keydown', event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  lookupButton.click();
              }
          });
          updateCounter();
          const actionRow = document.createElement('div');
          actionRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
          const lookupButton = makeEzButton('Find', true);
          lookupButton.title = 'Find documents (Ctrl+Enter)';
          const copyAllButton = makeEzButton('Copy Results');
          const copyMissingButton = makeEzButton('Copy Not Visible');
          const clearButton = makeEzButton('Clear');
          const columnsButton = makeEzButton('Columns \u25BE');
          columnsButton.title = 'Choose which fields appear in the results and in Copy Results';
          // Search All Versions (unchecked by default = latest versions only)
          const allVersionsLabel = document.createElement('label');
          allVersionsLabel.title = 'When unchecked, only the latest version of each document is searched.';
          allVersionsLabel.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin:0 4px;font-weight:normal;font-size:12px;cursor:pointer;white-space:nowrap;';
          const allVersionsBox = document.createElement('input');
          allVersionsBox.type = 'checkbox';
          allVersionsBox.id = 'ez-find-all-versions';
          allVersionsBox.checked = false;
          allVersionsBox.style.cssText = 'width:14px;height:14px;margin:0;cursor:pointer;';
          const allVersionsText = document.createElement('span');
          allVersionsText.textContent = 'Search All Versions';
          allVersionsLabel.append(allVersionsBox, allVersionsText);
          copyAllButton.disabled = true;
          copyMissingButton.disabled = true;
          const status = document.createElement('span');
          status.setAttribute('role', 'status');
          status.style.cssText = 'margin-left:auto;font-size:12px;color:#555;';
          // Options row (above the action buttons): Search All Versions + Columns
          const optionsRow = document.createElement('div');
          optionsRow.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
          allVersionsLabel.style.margin = '0';
          optionsRow.append(allVersionsLabel, columnsButton);
          actionRow.append(lookupButton, copyAllButton, copyMissingButton, clearButton, counter, status);
          const columnPicker = buildFindColumnPicker(() => renderFindResults(resultsBox, findLastResults));
          columnsButton.addEventListener('click', () => {
              const open = columnPicker.panel.style.display === 'none';
              columnPicker.panel.style.display = open ? 'block' : 'none';
              columnsButton.textContent = open ? 'Columns \u25B4' : 'Columns \u25BE';
          });
          // Warning banner shown when the input exceeds FIND_MAX_IDS.
          const cutoffNotice = document.createElement('div');
          cutoffNotice.setAttribute('role', 'alert');
          cutoffNotice.style.cssText = 'display:none;align-items:center;gap:10px;padding:6px 10px;border:1px solid #d6a400;border-left:4px solid #d6a400;border-radius:4px;background:#fff4ce;color:#5c4400;font-size:12px;';
          const cutoffText = document.createElement('span');
          cutoffText.style.cssText = 'flex:1 1 auto;';
          const copyNotSearchedButton = makeEzButton('Copy Not Searched');
          copyNotSearchedButton.title = 'Copy the IDs that were not searched (one per line) so you can run them in another lookup';
          copyNotSearchedButton.style.cssText += 'flex:0 0 auto;white-space:nowrap;background:#fff;border-color:#d6a400;color:#5c4400;';
          cutoffNotice.append(cutoffText, copyNotSearchedButton);
          let notSearchedValues = [];
          copyNotSearchedButton.addEventListener('click', () => {
              if (!notSearchedValues.length) return;
              copyToClipboard(notSearchedValues.join('\r\n'))
                  .then(() => flashButton(copyNotSearchedButton, `\u2713 Copied ${notSearchedValues.length.toLocaleString('en-US')}`))
                  .catch(() => alert('Failed to copy the IDs that were not searched.'));
          });
          // skipped: the parsed items beyond FIND_MAX_IDS, in input order.
          const setCutoffNotice = (total, searched, skipped = []) => {
              notSearchedValues = skipped.map(item => item.input);
              if (total > searched) {
                  cutoffText.textContent = `\u26A0 Results cut off: you entered ${total.toLocaleString('en-US')} unique IDs, ` +
                      `but only the first ${searched.toLocaleString('en-US')} were searched. ` +
                      `The remaining ${(total - searched).toLocaleString('en-US')} were not searched; copy them to run a separate lookup.`;
                  cutoffNotice.style.display = 'flex';
              } else {
                  cutoffText.textContent = '';
                  cutoffNotice.style.display = 'none';
              }
          };
          const resultsBox = document.createElement('div');
          resultsBox.style.cssText = 'overflow:auto;flex:1 1 auto;min-height:0;border:1px solid #e3e3e3;border-radius:4px;';
          const note = document.createElement('div');
          note.style.cssText = 'color:#777;font-size:11px;';
          note.textContent = '"Not visible to me" means no document you can see matches; it may not exist, may not have migrated, or may be restricted. Hover over the ignored count to see values that didn\'t match an accepted pattern.';
          body.append(hint, input, optionsRow, columnPicker.panel, actionRow, cutoffNotice, resultsBox, note);
          const footer = document.createElement('div');
          footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #e3e3e3;background:#fafafa;';
          const closeButton = makeEzButton('Close');
          closeButton.addEventListener('click', () => { if (!findLookupActive) closeFindByIdDialog(); });
          footer.appendChild(closeButton);
          const resultKey = r => `${r.inputType}:${r.input}`;
          const renderResults = results => {
              findLastResults = results;
              renderFindResults(resultsBox, results);
              const found = new Set(results.filter(r => r.found).map(resultKey)).size;
              const inputs = new Set(results.map(resultKey)).size;
              copyAllButton.disabled = results.length === 0;
              copyMissingButton.disabled = inputs - found === 0;
              status.textContent = results.length
                  ? `${found} of ${inputs} found \u2022 ${inputs - found} not visible \u2022 ${results.filter(r => r.found).length} result rows`
                  : '';
          };
          lookupButton.addEventListener('click', async () => {
              const { items: allItems } = parseFindInput(input.value);
              if (!allItems.length) { setCutoffNotice(0, 0); status.textContent = 'No IDs or document numbers detected.'; return; }
              // Search only the first FIND_MAX_IDS values (in input order) and warn about the rest.
              const items = allItems.slice(0, FIND_MAX_IDS);
              setCutoffNotice(allItems.length, items.length, allItems.slice(FIND_MAX_IDS));
              findLookupActive = true;
              [lookupButton, clearButton, closeButton, allVersionsBox].forEach(b => { b.disabled = true; });
              status.style.color = '#555';
              status.textContent = 'Looking up...';
              try {
                  const { results, unavailable } = await findDocumentsById(items, allVersionsBox.checked, (done, total, batchNo, batchCount) => {
                      status.textContent = `Checked ${done} of ${total} (query ${batchNo} of ${batchCount})...`;
                  });
                  columnPicker.setUnavailable(unavailable);
                  renderResults(results);
              } catch (error) {
                  console.error('[EZ Veeva Helper] Find By ID failed:', error);
                  status.style.color = '#b3261e';
                  status.textContent = `Lookup failed: ${error.message}`;
              } finally {
                  findLookupActive = false;
                  [lookupButton, clearButton, closeButton, allVersionsBox].forEach(b => { b.disabled = false; });
              }
          });
          copyAllButton.addEventListener('click', () => {
              copyToClipboard(findResultsToTsv(findLastResults))
                  .then(() => flashButton(copyAllButton, '\u2713 Copied'))
                  .catch(() => alert('Failed to copy results.'));
          });
          copyMissingButton.addEventListener('click', () => {
              const missing = findLastResults.filter(r => !r.found).map(r => r.input);
              copyToClipboard(missing.join('\r\n'))
                  .then(() => flashButton(copyMissingButton, `\u2713 Copied ${missing.length}`))
                  .catch(() => alert('Failed to copy IDs.'));
          });
          clearButton.addEventListener('click', () => {
              input.value = '';
              updateCounter();
              setCutoffNotice(0, 0);
              renderResults([]);
              input.focus();
          });
          dialog.append(header, body, footer);
          overlay.appendChild(dialog);
          document.body.appendChild(overlay);
          if (findLastResults.length) renderResults(findLastResults);
          input.focus();
      }
      // ---- All Related Documents (document actions menu) -------------------------
      // Adds an "All Related Documents" item to the document actions (three dots)
      // menu, between "Where Used" and "Version History". It runs a VQL query on
      // the relationships object for the document version the menu belongs to
      // and shows the related documents in the same report window style as
      // Find By ID. Works for the menu next to a document in the Library grid and
      // the All Actions menu at the top right of the document page.
      const RELATED_MENU_ITEM_CLASS = 'ez-related-docs-menu-item';
      const RELATED_OVERLAY_ID = 'ez-related-docs-overlay';
      const WHERE_USED_ITEM = 'li[data-value="ViewWhereUsed"], li[role="option"][aria-label="Where Used"]';
      const VERSION_HISTORY_ITEM = 'li[data-value="ViewVersions"], li[role="option"][aria-label="Version History"]';
      const DOC_INFO_HREF = /#doc_info\/(\d+)\/(\d+)\/(\d+)/i;
      let relatedLastTrigger = null;
      let relatedLookupActive = false;

      // Remember which "..." button opened a menu, so the menu item knows which
      // document it belongs to (the menu itself is rendered in a detached portal).
      function installRelatedDocsTriggerTracking() {
          const remember = event => {
              const target = event.target instanceof Element ? event.target : null;
              const button = target && target.closest('button[aria-haspopup="true"]');
              if (button && !button.closest(`#${RELATED_OVERLAY_ID}, #ez-find-by-id-overlay`)) {
                  relatedLastTrigger = button;
              }
          };
          document.addEventListener('pointerdown', remember, true);
          document.addEventListener('keydown', event => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') remember(event);
          }, true);
      }

      function findOpenMenuTrigger() {
          if (relatedLastTrigger && relatedLastTrigger.isConnected &&
              relatedLastTrigger.getAttribute('aria-expanded') === 'true') {
              return relatedLastTrigger;
          }
          const open = Array.from(document.querySelectorAll('button[aria-haspopup="true"][aria-expanded="true"]'))
              .filter(b => b.closest('.vv-more-actions-button, .vv-action-menu, .vv-action-dropdown-menu, .vv-action-link-view-cell, .documentActionBarContainer'));
          return open[0] || relatedLastTrigger;
      }

      function parseVersionText(text) {
          const match = String(text || '').match(/(\d+)\.(\d+)/);
          return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
      }

      // Works out the document ID / version the menu was opened for.
      function resolveDocContext(trigger) {
          // Library / search grid: walk up from the "..." button to the smallest
          // container that holds links to exactly one document.
          if (trigger && !trigger.closest('.documentActionBarContainer, #docInfoHeader')) {
              let el = trigger.parentElement;
              for (let depth = 0; el && depth < 12; depth += 1, el = el.parentElement) {
                  const links = Array.from(el.querySelectorAll('a[href*="#doc_info/"]'));
                  if (!links.length) continue;
                  const parsed = links
                      .map(a => ({ a, m: (a.getAttribute('href') || '').match(DOC_INFO_HREF) }))
                      .filter(x => x.m);
                  if (!parsed.length) continue;
                  if (new Set(parsed.map(x => x.m[1])).size !== 1) break;
                  const first = parsed.find(x => x.a.classList.contains('vv-action-link-link-anchor')) || parsed[0];
                  const charm = el.querySelector('.versionNumber');
                  const version = parseVersionText(charm && charm.textContent) ||
                      { major: Number(first.m[2]), minor: Number(first.m[3]) };
                  return {
                      docId: first.m[1],
                      major: version.major,
                      minor: version.minor,
                      name: first.a.textContent.trim(),
                      docNumber: ''
                  };
              }
          }
          // Document page: ID from the URL, version from the page itself.
          const hashMatch = window.location.hash.match(DOC_INFO_HREF);
          if (!hashMatch) return null;
          const versionValue = document.querySelector('.docInfoValue-version');
          const headerSuffix = document.querySelector('#docInfoHeader [class*="HeaderText-module__suffix"]');
          const version = parseVersionText(versionValue && (versionValue.getAttribute('valuekey') || versionValue.textContent)) ||
              parseVersionText(headerSuffix && headerSuffix.textContent);
          const nameEl = document.querySelector('#docInfoHeader [class*="HeaderText-module__text"]');
          const numberEl = document.querySelector('#docInfoHeader [class*="DocInfoHeader-module__docNumber"]');
          return {
              docId: hashMatch[1],
              major: version ? version.major : null,   // resolved through the API if missing
              minor: version ? version.minor : null,
              name: nameEl ? nameEl.textContent.trim() : '',
              docNumber: numberEl ? numberEl.textContent.trim() : ''
          };
      }

      // Vault's native "relationships" icon (Font Awesome regular code-merge).
      const RELATED_ICON_PATH = 'M304 192c-38 0-69.8 26.5-77.9 62-23.9-3.5-58-12.9-83.9-37.6-16.6-15.9-27.9-36.5-33.7-61.6C138.6 143.3 160 114.1 160 80c0-44.2-35.8-80-80-80S0 35.8 0 80c0 35.8 23.5 66.1 56 76.3v199.3C23.5 365.9 0 396.2 0 432c0 44.2 35.8 80 80 80s80-35.8 80-80c0-35.8-23.5-66.1-56-76.3V246.1c1.6 1.7 3.3 3.4 5 5 39.3 37.5 90.4 48.6 121.2 51.8 12.1 28.9 40.6 49.2 73.8 49.2 44.2 0 80-35.8 80-80S348.2 192 304 192zM80 48c17.6 0 32 14.4 32 32s-14.4 32-32 32-32-14.4-32-32 14.4-32 32-32zm0 416c-17.6 0-32-14.4-32-32s14.4-32 32-32 32 14.4 32 32-14.4 32-32 32zm224-160c-17.6 0-32-14.4-32-32s14.4-32 32-32 32 14.4 32 32-14.4 32-32 32z';
      // Builds the icon the same way in the grid menu and the document page menu.
      // It copies the sizing class (css-...-iconCSS) from the menu's own icon so
      // it lines up with the other items, and swaps in the code-merge glyph.
      function makeRelatedDocsIcon(templateSvg) {
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('focusable', 'false');
          svg.setAttribute('role', 'img');
          svg.setAttribute('data-prefix', 'far');
          svg.setAttribute('data-icon', 'code-merge');
          svg.setAttribute('viewBox', '0 0 384 512');
          const sizingClasses = templateSvg
              ? Array.from(templateSvg.classList).filter(c => !/^fa-/.test(c) && c !== 'svg-inline--fa')
              : [];
          svg.setAttribute('class', ['svg-inline--fa', 'fa-code-merge', 'fa-w-12', ...sizingClasses].join(' '));
          if (!sizingClasses.length) {
              // Fallback when the menu has no icon to copy: standard FA sizing.
              svg.style.cssText = 'height:1em;width:0.75em;overflow:visible;vertical-align:-0.125em;';
          }
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('fill', 'currentColor');
          path.setAttribute('d', RELATED_ICON_PATH);
          // Overlay a compact two-headed horizontal arrow to make the
          // source/target (bi-directional) relationship search obvious.
          const arrows = document.createElementNS(svgNS, 'path');
          arrows.setAttribute('d', 'M120 368 H264 M120 368 L148 340 M120 368 L148 396 M264 368 L236 340 M264 368 L236 396');
          arrows.setAttribute('fill', 'none');
          arrows.setAttribute('stroke', 'currentColor');
          arrows.setAttribute('stroke-width', '24');
          arrows.setAttribute('stroke-linecap', 'round');
          arrows.setAttribute('stroke-linejoin', 'round');
          svg.append(path, arrows);
          return svg;
      }

      function closeVaultMenu(item, trigger) {
          if (trigger && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') {
              trigger.click();   // toggles the menu closed
          }
          window.setTimeout(() => {
              if (!item.isConnected) return;
              const list = item.closest('[role="listbox"]') || item.parentElement;
              if (list) {
                  list.dispatchEvent(new KeyboardEvent('keydown', {
                      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                  }));
              }
          }, 80);
      }

      function buildRelatedDocsMenuItem(template) {
          const item = template.cloneNode(true);
          item.classList.add(RELATED_MENU_ITEM_CLASS);
          item.id = `ez-related-docs-menu-item-${Date.now()}`;
          item.dataset.value = 'EzRelatedDocuments';
          item.setAttribute('aria-label', 'All Related Documents');
          item.setAttribute('aria-selected', 'false');
          item.title = 'EZ Veeva Helper: list all documents related to this document version in both directions';
          item.querySelectorAll('.vv-action-bar-menu-item-key-combo').forEach(n => n.remove());
          const label = item.querySelector('.vv-action-bar-menu-item-label') || item;
          const iconBox = label.querySelector('.vv-action-bar-menu-icon-container');
          Array.from(label.childNodes).forEach(node => { if (node !== iconBox) node.remove(); });
          if (iconBox) {
              iconBox.replaceChildren(makeRelatedDocsIcon(template.querySelector('.vv-action-bar-menu-icon-container svg')));
          } else {
              const box = document.createElement('span');
              box.className = 'vv-action-bar-menu-icon-container';
              box.setAttribute('role', 'img');
              box.style.cssText = 'display:inline-flex;justify-content:center;width:1.25em;margin-right:6px;';
              box.appendChild(makeRelatedDocsIcon(null));
              label.appendChild(box);
          }
          label.appendChild(document.createTextNode('All Related Documents'));

          // The cloned item has no React handlers, so give it its own hover state
          // and keep Vault's menu from treating the click as one of its actions.
          const originalBackground = item.style.backgroundColor;
          item.addEventListener('mouseenter', () => { item.style.backgroundColor = '#eef3fb'; });
          item.addEventListener('mouseleave', () => { item.style.backgroundColor = originalBackground; });
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
              item.addEventListener(type, event => event.stopPropagation());
          });
          item.addEventListener('click', event => {
              event.preventDefault();
              event.stopPropagation();
              const trigger = item.ezTrigger || findOpenMenuTrigger();
              const context = item.ezContext || resolveDocContext(trigger);
              closeVaultMenu(item, trigger);
              if (!hasApiAccess()) {
                  alert('API access has not been confirmed. Open EZ settings and select Check API access.');
                  return;
              }
              if (!context) {
                  alert('Could not determine which document this menu belongs to.');
                  return;
              }
              openRelatedDocsDialog(context);
          });
          return item;
      }

      function addRelatedDocsMenuItem() {
          if (!isFeatureEnabled('relatedDocs') || !hasApiAccess()) return;
          document.querySelectorAll(`${WHERE_USED_ITEM}, ${VERSION_HISTORY_ITEM}`).forEach(anchorItem => {
              const list = anchorItem.parentElement;
              if (!list || list.querySelector(`.${RELATED_MENU_ITEM_CLASS}`)) return;
              const whereUsed = list.querySelector(WHERE_USED_ITEM);
              const versionHistory = list.querySelector(VERSION_HISTORY_ITEM);
              const item = buildRelatedDocsMenuItem(whereUsed || versionHistory);
              item.ezTrigger = findOpenMenuTrigger();
              item.ezContext = resolveDocContext(item.ezTrigger);
              if (whereUsed) whereUsed.insertAdjacentElement('afterend', item);
              else versionHistory.insertAdjacentElement('beforebegin', item);
          });
      }

      function removeRelatedDocsMenuItems() {
          document.querySelectorAll(`.${RELATED_MENU_ITEM_CLASS}`).forEach(el => el.remove());
      }

      function closeRelatedDocsDialog() {
          const overlay = document.getElementById(RELATED_OVERLAY_ID);
          if (overlay) overlay.remove();
      }

      // relationship_type__v API names -> readable labels
      // (e.g. supporting_documents__vs -> Supporting Documents).
      function prettifyRelationshipType(value) {
          const text = toValueList(value)[0] || '';
          return text
              .replace(/__[a-z]+$/i, '')
              .split('_')
              .filter(Boolean)
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ') || text;
      }

      function buildRelatedDocsVql(docId, major, minor) {
          // docId is digits only; major/minor are numbers (validated by callers).
          const side = name => `(${name}_doc_id__v = '${docId}' AND ((${name}_major_version__v = ${major} ` +
              `AND ${name}_minor_version__v = ${minor}) OR ${name}_major_version__v = null))`;
          return 'SELECT id, relationship_type__v, ' +
              'source_doc_id__v, source_major_version__v, source_minor_version__v, ' +
              'target_doc_id__v, target_major_version__v, target_minor_version__v ' +
              `FROM relationships WHERE ${side('source')} OR ${side('target')}`;
      }

      async function resolveLatestVersion(docId) {
          const rows = await runVql(`SELECT id, major_version_number__v, minor_version_number__v FROM documents WHERE id = ${docId}`);
          if (!rows.length) throw new Error(`Document ${docId} is not visible to you.`);
          return { major: Number(rows[0].major_version_number__v), minor: Number(rows[0].minor_version_number__v) };
      }

      // Turns relationship rows into one entry per relationship, from the point
      // of view of the selected document (Outgoing = selected doc is the source).
      function buildRelations(rows, context) {
          const id = String(context.docId);
          const isBlank = v => v === null || v === undefined || v === '';
          const matchesContext = (major, minor) => isBlank(major) ||
              (Number(major) === context.major && Number(minor) === context.minor);
          const seen = new Set();
          const relations = [];
          rows.forEach(row => {
              const key = String(row.id);
              if (seen.has(key)) return;
              seen.add(key);
              const isSource = String(row.source_doc_id__v) === id;
              const isTarget = String(row.target_doc_id__v) === id;
              const outgoing = isSource &&
                  (!isTarget || matchesContext(row.source_major_version__v, row.source_minor_version__v));
              const other = outgoing ? 'target' : 'source';
              const major = row[`${other}_major_version__v`];
              const minor = row[`${other}_minor_version__v`];
              relations.push({
                  relationshipId: key,
                  type: toValueList(row.relationship_type__v)[0] || '',
                  relationship: prettifyRelationshipType(row.relationship_type__v),
                  direction: outgoing ? 'Outgoing \u2192' : '\u2190 Incoming',
                  relatedId: String(row[`${other}_doc_id__v`] || ''),
                  bound: isBlank(major) ? null : { major: Number(major), minor: Number(isBlank(minor) ? 0 : minor) }
              });
          });
          relations.sort((a, b) =>
              a.relationship.localeCompare(b.relationship) ||
              a.direction.localeCompare(b.direction) ||
              (Number(a.relatedId) - Number(b.relatedId)));
          return relations;
      }

      async function findRelatedDocuments(context, onStatus) {
          let major = context.major;
          let minor = context.minor;
          if (!Number.isFinite(major) || !Number.isFinite(minor)) {
              onStatus('Resolving document version...');
              ({ major, minor } = await resolveLatestVersion(context.docId));
              context.major = major;
              context.minor = minor;
          }
          onStatus('Finding relationships...');
          const relationshipRows = await runVql(buildRelatedDocsVql(context.docId, major, minor));
          const relations = buildRelations(relationshipRows, context);
          if (!relations.length) return { rows: [], unavailable: [], relationshipCount: 0 };

          // Look the related documents up with the same engine as Find By ID.
          // Search all versions only if a relationship points at a specific version.
          const ids = [...new Set(relations.map(r => r.relatedId))].filter(x => /^\d+$/.test(x));
          const needAllVersions = relations.some(r => r.bound);
          const items = ids.map(x => ({ input: x, type: 'veevaId', key: x }));
          onStatus(`Loading details for ${ids.length} related document${ids.length === 1 ? '' : 's'}...`);
          const { results, unavailable } = await findDocumentsById(items, needAllVersions, (done, total, batchNo, batchCount) => {
              onStatus(`Loading details: ${done} of ${total} (query ${batchNo} of ${batchCount})...`);
          });
          const byId = new Map();
          results.filter(r => r.found).forEach(r => {
              if (!byId.has(r.veevaId)) byId.set(r.veevaId, []);
              byId.get(r.veevaId).push(r);
          });
          const rows = relations.map(rel => {
              const candidates = byId.get(rel.relatedId) || [];
              const hit = rel.bound
                  ? candidates.find(c => c.version === `${rel.bound.major}.${rel.bound.minor}`)
                  : (candidates.find(c => c.latest) || (needAllVersions ? null : candidates[0]));
              const base = {
                  relationship: rel.relationship,
                  relationshipType: rel.type,
                  direction: rel.direction,
                  boundTo: rel.bound ? `v${rel.bound.major}.${rel.bound.minor}` : 'Latest version',
                  relatedId: rel.relatedId,
                  input: rel.relatedId,
                  inputType: 'Veeva ID'
              };
              return hit
                  ? Object.assign({}, hit, base, { found: true })
                  : Object.assign({ found: false, extra: {} }, base);
          });
          return { rows, unavailable, relationshipCount: relations.length };
      }

      function relatedResultsToTsv(results) {
          const optional = getActiveFindColumns();
          const header = ['Relationship', 'Relationship Type', 'Direction', 'Related To', 'Veeva ID', 'Result',
              'Document #', 'Version', 'Latest?', ...optional.map(c => c.label), 'URL'];
          const clean = v => String(v || '').replace(/[\t\r\n]+/g, ' ');
          const lines = results.map(r => [
              r.relationship, r.relationshipType, r.direction.replace(/[\u2190\u2192]/g, '').trim(), r.boundTo,
              r.relatedId, r.found ? 'Found' : 'Not visible to me',
              r.docNumber || '', r.version || '', r.found ? (r.latest ? 'Yes' : 'No') : '',
              ...optional.map(c => (r.extra || {})[c.key]),
              r.url || ''
          ].map(clean).join('\t'));
          return [header.join('\t'), ...lines].join('\r\n');
      }

      function openRelatedDocsDialog(context) {
          if (!hasApiAccess()) {
              alert('API access has not been confirmed. Open EZ settings and select Check API access.');
              return;
          }
          if (relatedLookupActive) return;
          closeRelatedDocsDialog();
          let lastResults = [];

          const overlay = document.createElement('div');
          overlay.id = RELATED_OVERLAY_ID;
          overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,0.35);display:flex;align-items:flex-start;justify-content:center;padding-top:70px;';
          // Like Find By ID, the dialog only closes via the Close button.
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-modal', 'true');
          dialog.setAttribute('aria-labelledby', 'ez-related-docs-title');
          dialog.style.cssText = 'width:1040px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#222;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.3);font-size:13px;overflow:hidden;';

          const header = makeDialogHeader('ez-related-docs-title', 'EZ All Related Documents',
              closeRelatedDocsDialog, () => relatedLookupActive);

          const body = document.createElement('div');
          body.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;overflow:hidden;flex:1 1 auto;min-height:0;';

          const sourceLine = document.createElement('div');
          sourceLine.style.cssText = 'font-size:12px;color:#333;padding:6px 10px;border:1px solid #c8d4e8;border-left:4px solid #174ea6;border-radius:4px;background:#fbfdff;';
          const updateSourceLine = () => {
              const parts = [];
              if (context.docNumber) parts.push(context.docNumber);
              parts.push(`ID ${context.docId}`);
              if (Number.isFinite(context.major)) parts.push(`v${context.major}.${context.minor}`);
              sourceLine.replaceChildren();
              const strong = document.createElement('strong');
              strong.textContent = 'Related to: ';
              const name = document.createElement('span');
              name.textContent = context.name || '(document)';
              name.style.fontWeight = '600';
              const meta = document.createElement('span');
              meta.style.color = '#555';
              meta.textContent = ` \u2022 ${parts.join(' \u2022 ')}`;
              sourceLine.append(strong, name, meta);
          };
          updateSourceLine();

          const optionsRow = document.createElement('div');
          optionsRow.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
          const columnsButton = makeEzButton('Columns \u25BE');
          columnsButton.title = 'Choose which fields appear in the results and in Copy Results';
          optionsRow.appendChild(columnsButton);

          const actionRow = document.createElement('div');
          actionRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
          const refreshButton = makeEzButton('Refresh', true);
          refreshButton.title = 'Run the relationship lookup again (needed after adding a custom column)';
          const copyAllButton = makeEzButton('Copy Results');
          const copyMissingButton = makeEzButton('Copy Not Visible');
          copyAllButton.disabled = true;
          copyMissingButton.disabled = true;
          const status = document.createElement('span');
          status.setAttribute('role', 'status');
          status.style.cssText = 'margin-left:auto;font-size:12px;color:#555;';
          actionRow.append(refreshButton, copyAllButton, copyMissingButton, status);

          const resultsBox = document.createElement('div');
          resultsBox.style.cssText = 'overflow:auto;flex:1 1 auto;min-height:60px;border:1px solid #e3e3e3;border-radius:4px;';

          const columnPicker = buildFindColumnPicker(
              () => renderFindResults(resultsBox, lastResults, RELATED_FIXED_COLUMNS),
              RELATED_FIXED_COLUMNS.map(c => c.label));
          columnsButton.addEventListener('click', () => {
              const open = columnPicker.panel.style.display === 'none';
              columnPicker.panel.style.display = open ? 'block' : 'none';
              columnsButton.textContent = open ? 'Columns \u25B4' : 'Columns \u25BE';
          });

          const note = document.createElement('div');
          note.style.cssText = 'color:#777;font-size:11px;';
          note.textContent = 'Outgoing = this document is the source of the relationship; Incoming = this document is the target. ' +
              '"Related To" shows whether the relationship points to a specific version or to the latest version. ' +
              '"Not visible to me" means the related document (or that version) is not visible to you.';

          body.append(sourceLine, optionsRow, columnPicker.panel, actionRow, resultsBox, note);

          const footer = document.createElement('div');
          footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #e3e3e3;background:#fafafa;';
          const closeButton = makeEzButton('Close');
          closeButton.addEventListener('click', () => { if (!relatedLookupActive) closeRelatedDocsDialog(); });
          footer.appendChild(closeButton);

          const showEmpty = text => {
              const empty = document.createElement('div');
              empty.style.cssText = 'padding:14px;color:#555;font-size:12px;';
              empty.textContent = text;
              resultsBox.replaceChildren(empty);
          };

          const runLookup = async () => {
              relatedLookupActive = true;
              [refreshButton, closeButton, copyAllButton, copyMissingButton].forEach(b => { b.disabled = true; });
              status.style.color = '#555';
              showEmpty('Looking up related documents...');
              try {
                  const { rows, unavailable, relationshipCount } = await findRelatedDocuments(context, text => {
                      status.textContent = text;
                  });
                  updateSourceLine();
                  lastResults = rows;
                  columnPicker.setUnavailable(unavailable);
                  if (!relationshipCount) {
                      showEmpty('No related documents were found for this document version.');
                      status.textContent = '0 relationships';
                      return;
                  }
                  renderFindResults(resultsBox, rows, RELATED_FIXED_COLUMNS);
                  const found = rows.filter(r => r.found).length;
                  status.textContent = `${relationshipCount} relationship${relationshipCount === 1 ? '' : 's'} \u2022 ` +
                      `${found} visible \u2022 ${relationshipCount - found} not visible`;
                  copyAllButton.disabled = false;
                  copyMissingButton.disabled = found === relationshipCount;
              } catch (error) {
                  console.error('[EZ Veeva Helper] Related Documents lookup failed:', error);
                  status.style.color = '#b3261e';
                  status.textContent = `Lookup failed: ${error.message}`;
                  showEmpty('The relationship lookup failed. See the message above.');
              } finally {
                  relatedLookupActive = false;
                  refreshButton.disabled = false;
                  closeButton.disabled = false;
              }
          };

          refreshButton.addEventListener('click', () => { if (!relatedLookupActive) runLookup(); });
          copyAllButton.addEventListener('click', () => {
              copyToClipboard(findResultsToTsv(lastResults, 'related'))
                  .then(() => flashButton(copyAllButton, '\u2713 Copied'))
                  .catch(() => alert('Failed to copy results.'));
          });
          copyMissingButton.addEventListener('click', () => {
              const missing = [...new Set(lastResults.filter(r => !r.found).map(r => r.relatedId))];
              copyToClipboard(missing.join('\r\n'))
                  .then(() => flashButton(copyMissingButton, `\u2713 Copied ${missing.length}`))
                  .catch(() => alert('Failed to copy IDs.'));
          });

          dialog.append(header, body, footer);
          overlay.appendChild(dialog);
          document.body.appendChild(overlay);
          runLookup();
      }

      // ---- Find By ID button (right of the main search bar) ----------------
      function removeFindByIdButton() {
          const button = document.getElementById('ez-find-by-id-button');
          if (button) button.remove();
      }
      function addFindByIdButton() {
          if (!isFeatureEnabled('findById') || !hasApiAccess()) return;
          if (document.getElementById('ez-find-by-id-button')) return;
          const searchPanel = document.querySelector('div.searchNav.vv_search_panel');
          if (!searchPanel || !searchPanel.parentElement) return;
          const button = document.createElement('button');
          button.id = 'ez-find-by-id-button';
          button.type = 'button';
          button.title = 'Find documents by Veeva ID, document number or GDMS ID';
          button.setAttribute('aria-label', 'Find By ID');
          button.style.cssText = 'display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;align-self:center;' +
              'vertical-align:middle;height:28px;margin:0;padding:0 10px;cursor:pointer;white-space:nowrap;' +
              'background:#ffffff;border:1px solid #c8d4e8;border-radius:4px;color:#174ea6;font-size:12px;font-weight:600;line-height:1;';
          const svgNS = 'http://www.w3.org/2000/svg';
          const icon = document.createElementNS(svgNS, 'svg');
          icon.setAttribute('width', '14');
          icon.setAttribute('height', '14');
          icon.setAttribute('viewBox', '0 0 16 16');
          icon.setAttribute('aria-hidden', 'true');
          icon.setAttribute('focusable', 'false');
          icon.style.cssText = 'display:block;flex:0 0 14px;';
          const lens = document.createElementNS(svgNS, 'circle');
          lens.setAttribute('cx', '6.5');
          lens.setAttribute('cy', '6.5');
          lens.setAttribute('r', '4.5');
          lens.setAttribute('fill', 'none');
          lens.setAttribute('stroke', 'currentColor');
          lens.setAttribute('stroke-width', '1.8');
          const handle = document.createElementNS(svgNS, 'path');
          handle.setAttribute('d', 'M10 10 L14.5 14.5');
          handle.setAttribute('stroke', 'currentColor');
          handle.setAttribute('stroke-width', '1.8');
          handle.setAttribute('stroke-linecap', 'round');
          icon.append(lens, handle);
          const text = document.createElement('span');
          text.textContent = 'Find By ID';
          button.append(icon, text);
          button.addEventListener('mouseenter', () => { button.style.background = '#eef3fb'; });
          button.addEventListener('mouseleave', () => { button.style.background = '#ffffff'; });
          button.addEventListener('click', event => {
              event.preventDefault();
              event.stopPropagation();
              openFindByIdDialog();
          });
          searchPanel.insertAdjacentElement('afterend', button);
          alignFindByIdButton();
          window.setTimeout(alignFindByIdButton, 250);
      }
      // Pull the button left so it sits ~20px from the visible end of the search
      // box, regardless of how much empty width/margin the search panel has.
      const FIND_BUTTON_GAP_PX = 20;
      function getSearchContentRight(searchPanel) {
          const panelRect = searchPanel.getBoundingClientRect();
          let right = null;
          searchPanel.querySelectorAll(
              'input, button, select, [role="combobox"], [role="button"], [role="search"], svg, img, [class*="search_box"], [class*="searchBox"]'
          ).forEach(el => {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return;
              // Ignore dropdowns / popups that render outside the bar.
              if (rect.top > panelRect.bottom || rect.bottom < panelRect.top) return;
              const style = window.getComputedStyle(el);
              if (style.visibility === 'hidden' || style.display === 'none') return;
              if (right === null || rect.right > right) right = rect.right;
          });
          return right === null ? panelRect.right : right;
      }
      function alignFindByIdButton() {
          const button = document.getElementById('ez-find-by-id-button');
          const searchPanel = document.querySelector('div.searchNav.vv_search_panel');
          if (!button || !searchPanel || !button.isConnected) return;
          const contentRight = getSearchContentRight(searchPanel);
          const currentMargin = Number.parseFloat(button.style.marginLeft) || 0;
          const buttonLeft = button.getBoundingClientRect().left;
          const gap = buttonLeft - contentRight;
          const nextMargin = Math.round(currentMargin - gap + FIND_BUTTON_GAP_PX);
          if (Math.abs(nextMargin - currentMargin) >= 1) {
              button.style.marginLeft = `${nextMargin}px`;
          }
      }
      window.addEventListener('resize', () => window.requestAnimationFrame(alignFindByIdButton));

      // ---- Settings icon + dialog -----------------------------------------
      // The navbar is built by React in stages, so items (and sometimes the
      // profile element itself) can appear or be re-rendered after the button is
      // added. Instead of inserting once, the button is pinned directly in front
      // of the visible user profile item, and moved back there on every
      // enhancement pass if anything has been inserted between them.
      function findNavbarProfileAnchor() {
          const candidates = Array.from(document.querySelectorAll('.vv-navbar-userprofile'))
              .filter(el => el.parentElement && el.getClientRects().length > 0);
          return candidates[0] || null;
      }
      function placeSettingsButton(button) {
          const profile = findNavbarProfileAnchor();
          if (!profile) return false;
          if (button.parentElement !== profile.parentElement || button.nextElementSibling !== profile) {
              profile.parentElement.insertBefore(button, profile);
          }
          return true;
      }
      function addSettingsButton() {
          const existing = document.getElementById('veeva-helper-settings-button');
          if (existing) {
              placeSettingsButton(existing);
              return;
          }
          if (!findNavbarProfileAnchor()) return;
          const button = document.createElement('button');
          button.id = 'veeva-helper-settings-button';
          button.type = 'button';
          button.title = 'EZ Veeva Helper settings';
          button.setAttribute('aria-label', 'EZ Veeva Helper settings');
          button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 6px 0 2px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;align-self:center;flex:0 0 auto;';
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('width', '22');
          svg.setAttribute('height', '22');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('focusable', 'false');
          svg.style.cssText = 'display:block;';
          const tile = document.createElementNS(svgNS, 'rect');
          tile.setAttribute('x', '0.5');
          tile.setAttribute('y', '0.5');
          tile.setAttribute('width', '23');
          tile.setAttribute('height', '23');
          tile.setAttribute('rx', '5.5');
          tile.setAttribute('fill', '#3d8ff2');
          const ring = document.createElementNS(svgNS, 'circle');
          ring.setAttribute('cx', '12');
          ring.setAttribute('cy', '12');
          ring.setAttribute('r', '9');
          ring.setAttribute('fill', 'none');
          ring.setAttribute('stroke', '#ffffff');
          ring.setAttribute('stroke-width', '1.3');
          const label = document.createElementNS(svgNS, 'text');
          label.setAttribute('x', '12');
          label.setAttribute('y', '12.5');
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('dominant-baseline', 'middle');
          label.setAttribute('fill', '#ffffff');
          label.setAttribute('font-family', 'Arial, Helvetica, sans-serif');
          label.setAttribute('font-size', '8.5');
          label.setAttribute('font-weight', '700');
          label.textContent = 'EZ';
          svg.append(tile, ring, label);
          button.appendChild(svg);
          button.addEventListener('mouseenter', () => { button.style.opacity = '0.85'; });
          button.addEventListener('mouseleave', () => { button.style.opacity = '1'; });
          button.addEventListener('click', event => {
              event.stopPropagation();
              openSettingsDialog();
          });
          placeSettingsButton(button);
      }
      function closeSettingsDialog() {
          const overlay = document.getElementById('veeva-helper-settings-overlay');
          if (overlay) overlay.remove();
          document.removeEventListener('keydown', handleSettingsKeydown, true);
      }
      function handleSettingsKeydown(event) {
          if (event.key === 'Escape') closeSettingsDialog();
      }
      function openSettingsDialog() {
          if (document.getElementById('veeva-helper-settings-overlay')) return;
          const overlay = document.createElement('div');
          overlay.id = 'veeva-helper-settings-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,0.35);display:flex;align-items:flex-start;justify-content:center;padding-top:90px;';
          overlay.addEventListener('click', event => {
              if (event.target === overlay) closeSettingsDialog();
          });
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-modal', 'true');
          dialog.setAttribute('aria-labelledby', 'veeva-helper-settings-title');
          dialog.style.cssText = 'width:460px;max-width:92vw;max-height:85vh;background:#fff;color:#222;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.3);font-size:13px;overflow-x:hidden;overflow-y:auto;';
          const header = document.createElement('div');
          header.style.cssText = 'padding:12px 16px;background:#174ea6;color:#fff;font-weight:700;font-size:14px;';
          header.id = 'veeva-helper-settings-title';
          header.textContent = 'EZ Veeva Helper Features';
          const body = document.createElement('div');
          body.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:14px;';
          // Settings are shown in two groups so it is clear which features need
          // Vault API access: Standard features, and API features (with one
          // shared "Check API access" control for the whole group).
          const buildFeatureRow = feature => {
              const row = document.createElement('label');
              row.style.cssText = 'display:flex;align-items:flex-start;gap:9px;cursor:pointer;font-weight:normal;margin:0;';
              const box = document.createElement('input');
              box.type = 'checkbox';
              box.dataset.featureKey = feature.key;
              box.checked = isFeatureEnabled(feature.key);
              box.style.cssText = 'width:15px;height:15px;margin:2px 0 0;cursor:pointer;flex:0 0 auto;';
              const text = document.createElement('span');
              const title = document.createElement('div');
              title.textContent = feature.label;
              title.style.cssText = 'font-weight:600;';
              const desc = document.createElement('div');
              desc.textContent = feature.description;
              desc.style.cssText = 'color:#666;font-size:12px;margin-top:2px;';
              text.append(title, desc);
              row.append(box, text);
              if (feature.requiresApi) {
                  const apiAllowed = hasApiAccess();
                  box.dataset.requiresApi = 'true';
                  box.checked = apiAllowed && isFeatureEnabled(feature.key);
                  box.disabled = !apiAllowed;
                  box.style.cursor = apiAllowed ? 'pointer' : 'not-allowed';
                  row.style.cursor = apiAllowed ? 'pointer' : 'default';
                  row.style.opacity = apiAllowed ? '1' : '0.6';
              }
              return row;
          };
          const makeSection = (titleText, subtitleText, accent, background) => {
              const section = document.createElement('fieldset');
              section.style.cssText = `margin:0;padding:8px 12px 12px;border:1px solid ${accent};border-radius:6px;background:${background};display:flex;flex-direction:column;gap:10px;min-width:0;`;
              const legend = document.createElement('legend');
              legend.textContent = titleText;
              legend.style.cssText = `padding:0 6px;font-weight:700;font-size:12px;color:${accent === '#d0d7e2' ? '#333' : '#174ea6'};width:auto;border:0;margin:0;`;
              section.appendChild(legend);
              if (subtitleText) {
                  const sub = document.createElement('div');
                  sub.textContent = subtitleText;
                  sub.style.cssText = 'color:#666;font-size:11px;margin-top:-4px;';
                  section.appendChild(sub);
              }
              return section;
          };

          // ---- Standard features (no API access needed) ----
          const standardSection = makeSection('Standard features', 'Work for every user; no API access needed.', '#d0d7e2', '#ffffff');
          FEATURE_DEFINITIONS.filter(f => !f.requiresApi)
              .forEach(feature => standardSection.appendChild(buildFeatureRow(feature)));

          // ---- API features ----
          const apiSection = makeSection('Requires Vault API access', '', '#8fb0e6', '#f5f8fe');
          const apiBar = document.createElement('div');
          apiBar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:4px;background:#ffffff;border:1px solid #dbe5f5;';
          const apiBadge = document.createElement('span');
          apiBadge.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;';
          const setApiBadge = (state, message) => {
              const styles = {
                  ok: ['#e6f4ea', '#137333', '\u2713 API access confirmed'],
                  denied: ['#fce8e6', '#b3261e', '\u2715 API access unavailable'],
                  unknown: ['#f1f3f4', '#555', '? API access not checked'],
                  checking: ['#eef3fb', '#174ea6', 'Checking API access...']
              }[state];
              apiBadge.style.background = styles[0];
              apiBadge.style.color = styles[1];
              apiBadge.textContent = styles[2];
              apiBadge.title = message || '';
          };
          const cached = getCachedApiAccess();
          setApiBadge(cached === true ? 'ok' : (cached === false ? 'denied' : 'unknown'));
          const checkLink = document.createElement('button');
          checkLink.type = 'button';
          checkLink.textContent = 'Check API access';
          checkLink.style.cssText = 'margin-left:auto;padding:0;border:0;background:transparent;color:#174ea6;cursor:pointer;text-decoration:underline;font-size:12px;';
          const apiHint = document.createElement('div');
          apiHint.style.cssText = 'flex-basis:100%;color:#666;font-size:11px;';
          const setApiHint = allowed => {
              apiHint.textContent = allowed
                  ? 'These features use your Vault session to run API (VQL) queries.'
                  : 'These features stay disabled until your API access is confirmed.';
          };
          setApiHint(cached === true);
          apiBar.append(apiBadge, checkLink, apiHint);
          apiSection.appendChild(apiBar);
          FEATURE_DEFINITIONS.filter(f => f.requiresApi)
              .forEach(feature => apiSection.appendChild(buildFeatureRow(feature)));

          checkLink.addEventListener('click', async event => {
              event.preventDefault();
              event.stopPropagation();
              checkLink.disabled = true;
              setApiBadge('checking');
              const result = await checkApiAccess();
              body.querySelectorAll('input[data-requires-api]').forEach(apiBox => {
                  apiBox.disabled = !result.allowed;
                  apiBox.checked = result.allowed;
                  apiBox.style.cursor = result.allowed ? 'pointer' : 'not-allowed';
                  const apiRow = apiBox.closest('label');
                  if (apiRow) {
                      apiRow.style.cursor = result.allowed ? 'pointer' : 'default';
                      apiRow.style.opacity = result.allowed ? '1' : '0.6';
                  }
              });
              setApiBadge(result.allowed ? 'ok' : 'denied', result.allowed ? '' : result.message);
              setApiHint(result.allowed);
              if (!result.allowed) apiHint.textContent += ` (${result.message})`;
              FEATURE_DEFINITIONS.filter(f => f.requiresApi)
                  .forEach(f => { featureSettings[f.key] = result.allowed; });
              window.localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(featureSettings));
              if (result.allowed) {
                  queueEnhancement();
              } else {
                  removeFindByIdButton();
                  closeFindByIdDialog();
                  removeRelatedDocsMenuItems();
                  closeRelatedDocsDialog();
              }
              checkLink.disabled = false;
          });

          body.append(standardSection, apiSection);
          const footer = document.createElement('div');
          footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #e3e3e3;background:#fafafa;';
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.textContent = 'Cancel';
          cancel.style.cssText = 'padding:5px 14px;cursor:pointer;background:#f3f3f3;border:1px solid #c8c8c8;border-radius:3px;color:#222;';
          cancel.addEventListener('click', closeSettingsDialog);
          const save = document.createElement('button');
          save.type = 'button';
          save.textContent = 'Save';
          save.style.cssText = 'padding:5px 16px;cursor:pointer;background:#174ea6;border:1px solid #174ea6;border-radius:3px;color:#fff;font-weight:600;';
          save.addEventListener('click', () => {
              const next = {};
              body.querySelectorAll('input[data-feature-key]').forEach(box => {
                  next[box.dataset.featureKey] = box.checked;
              });
              FEATURE_DEFINITIONS.filter(f => f.requiresApi)
                  .forEach(f => { next[f.key] = hasApiAccess() && next[f.key]; });
              saveFeatureSettings(next);
              closeSettingsDialog();
          });
          footer.append(cancel, save);
          dialog.append(header, body, footer);
          overlay.appendChild(dialog);
          document.body.appendChild(overlay);
          document.addEventListener('keydown', handleSettingsKeydown, true);
          save.focus();
      }
      function saveFeatureSettings(next) {
          const previous = featureSettings;
          featureSettings = Object.assign({}, previous, next);
          window.localStorage.setItem(FEATURE_SETTINGS_KEY, JSON.stringify(featureSettings));
          applyFeatureSettings(previous);
      }
      function applyFeatureSettings(previous) {
          // Page size changes the search request itself, so reload to get a
          // consistent grid and pager (Veeva default 25 vs custom size).
          if ((previous.pageSize !== false) !== isFeatureEnabled('pageSize')) {
              window.location.reload();
              return;
          }
          // Find By ID button
          if (!isFeatureEnabled('findById')) {
              removeFindByIdButton();
              closeFindByIdDialog();
          }
          // Related Documents menu item
          if (!isFeatureEnabled('relatedDocs')) {
              removeRelatedDocsMenuItems();
              closeRelatedDocsDialog();
          }
          // Bulk select / batch copy: rebuild the Easy Link Copy panel
          if (!isFeatureEnabled('bulkSelect')) {
              document.querySelectorAll('.veeva-copy-link-checkbox-container').forEach(el => el.remove());
          }
          const toolbar = document.querySelector(SELECTORS.selectionToolbar);
          if (toolbar) toolbar.remove();
          queueEnhancement();
      }

      function enhanceDocumentList() {
          addSettingsButton();
          addFindByIdButton();
          alignFindByIdButton();
          addRelatedDocsMenuItem();
          addDocumentCheckboxes();
          addSelectionToolbar();
          addPageSizeSelectorToPaginator();
          addCustomPager();
          updateSelectionToolbar();
      }

      function queueEnhancement() {
          if (refreshQueued) return;
          refreshQueued = true;

          window.requestAnimationFrame(() => {
              refreshQueued = false;
              enhanceDocumentList();
          });
      }

      function initializeDomFeatures() {
          enhanceDocumentList();

          installRelatedDocsTriggerTracking();
          const observer = new MutationObserver(queueEnhancement);
          observer.observe(document.body, { childList: true, subtree: true });
      }

      if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initializeDomFeatures, { once: true });
      } else {
          initializeDomFeatures();
      }
  })();
