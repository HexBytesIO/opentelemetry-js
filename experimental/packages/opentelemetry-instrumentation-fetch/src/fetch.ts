/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '@opentelemetry/api';
import {
  isWrapped,
  InstrumentationBase,
  InstrumentationConfig,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import * as core from '@opentelemetry/core';
import * as web from '@opentelemetry/sdk-trace-web';
import { AttributeNames } from './enums/AttributeNames';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { FetchResponse, SpanData } from './types';
import { VERSION } from './version';
import { _globalThis } from '@opentelemetry/core';

// how long to wait for observer to collect information about resources
// this is needed as event "load" is called before observer
// hard to say how long it should really wait, seems like 300ms is
// safe enough
const OBSERVER_WAIT_TIME_MS = 300;

export interface FetchCustomReqFunction {
  (span: api.Span, request: Request | RequestInit): void;
}

export interface FetchCustomResFunction {
  (span: api.Span, res: Response | Error): void;
}

/**
 * FetchPlugin Config
 */
export interface FetchInstrumentationConfig extends InstrumentationConfig {
  // the number of timing resources is limited, after the limit
  // (chrome 250, safari 150) the information is not collected anymore
  // the only way to prevent that is to regularly clean the resources
  // whenever it is possible, this is needed only when PerformanceObserver
  // is not available
  clearTimingResources?: boolean;
  // urls which should include trace headers when origin doesn't match
  propagateTraceHeaderCorsUrls?: web.PropagateTraceHeaderCorsUrls;
  /**
   * URLs that partially match any regex in ignoreUrls will not be traced.
   * In addition, URLs that are _exact matches_ of strings in ignoreUrls will
   * also not be traced.
   */
  ignoreUrls?: Array<string | RegExp>;
  /** Function for adding custom attributes on the span given the request */
  applyCustomAttributesOnReq?: FetchCustomReqFunction;
  /** Function for adding custom attributes on the span given the response */
  applyCustomAttributesOnRes?: FetchCustomResFunction;
  // Ignore adding network events as span events
  ignoreNetworkEvents?: boolean;
}

/**
 * This class represents a fetch plugin for auto instrumentation
 */
export class FetchInstrumentation extends InstrumentationBase<
  Promise<Response>
> {
  readonly component: string = 'fetch';
  readonly version: string = VERSION;
  moduleName = this.component;
  private _usedResources = new WeakSet<PerformanceResourceTiming>();
  private _tasksCount = 0;

  constructor(config?: FetchInstrumentationConfig) {
    super('@opentelemetry/instrumentation-fetch', VERSION, config);
  }

  init(): void {}

  private _getConfig(): FetchInstrumentationConfig {
    return this._config;
  }

  /**
   * Add cors pre flight child span
   * @param span
   * @param corsPreFlightRequest
   */
  private _addChildSpan(
    span: api.Span,
    corsPreFlightRequest: PerformanceResourceTiming
  ): void {
    const childSpan = this.tracer.startSpan(
      'CORS Preflight',
      {
        startTime: corsPreFlightRequest[web.PerformanceTimingNames.FETCH_START],
      },
      api.trace.setSpan(api.context.active(), span)
    );
    if (!this._getConfig().ignoreNetworkEvents) {
      web.addSpanNetworkEvents(childSpan, corsPreFlightRequest);
    }
    childSpan.end(
      corsPreFlightRequest[web.PerformanceTimingNames.RESPONSE_END]
    );
  }

  /**
   * Adds more attributes to span just before ending it
   * @param span
   * @param response
   */
  private _addFinalSpanAttributes(
    span: api.Span,
    response: FetchResponse
  ): void {
    this._addContentLengthAttribute(span, response);
    span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, response.status);
    if (response.statusText != null) {
      span.setAttribute(AttributeNames.HTTP_STATUS_TEXT, response.statusText);
    }
  }

  /**
   * Get http.host attribute from url
   * @param parsedUrl
   */
  private _getHostAttribute(
    parsedUrl: web.URLLike
  ): string {
    const portLess = parsedUrl.host.split(":")[1] === undefined;
    if (portLess) {
      const inferredPort = parsedUrl.protocol === 'https:' ? '443' : '80';
      return `${parsedUrl.host}:${inferredPort}`;
    }
    else return parsedUrl.host;
  }

  /**
   * Add content-length attribute to span
   * @param span
   * @param response
   */
  private _addContentLengthAttribute(
    span: api.Span,
    response: FetchResponse
  ): void {
    const headers = response.headers;
    if (!headers) return;

    const contentLengthHeader = headers.get('content-length');
    if (!contentLengthHeader) return;

    const contentLength = parseInt(contentLengthHeader as string, 10);
    if (isNaN(contentLength)) return;

    
    if (this._isCompressed(headers)) {
      span.setAttribute(SemanticAttributes.HTTP_RESPONSE_CONTENT_LENGTH, contentLength);
    } else {
      span.setAttribute(SemanticAttributes.HTTP_RESPONSE_CONTENT_LENGTH_UNCOMPRESSED, contentLength);
    }
  }

  /**
   * Check if response content is compressed 
   * @param headers
   */
  private _isCompressed(headers: Headers) {
    const encoding = headers.get('content-encoding');
    return !!encoding && encoding !== 'identity';
  }

  /**
   * Add headers
   * @param options
   * @param spanUrl
   */
  private _addHeaders(options: Request | RequestInit, spanUrl: string): void {
    if (
      !web.shouldPropagateTraceHeaders(
        spanUrl,
        this._getConfig().propagateTraceHeaderCorsUrls
      )
    ) {
      const headers: Partial<Record<string, unknown>> = {};
      api.propagation.inject(api.context.active(), headers);
      if (Object.keys(headers).length > 0) {
        this._diag.debug('headers inject skipped due to CORS policy');
      }
      return;
    }

    if (options instanceof Request) {
      api.propagation.inject(api.context.active(), options.headers, {
        set: (h, k, v) => h.set(k, typeof v === 'string' ? v : String(v)),
      });
    } else if (options.headers instanceof Headers) {
      api.propagation.inject(api.context.active(), options.headers, {
        set: (h, k, v) => h.set(k, typeof v === 'string' ? v : String(v)),
      });
    } else {
      const headers: Partial<Record<string, unknown>> = {};
      api.propagation.inject(api.context.active(), headers);
      options.headers = Object.assign({}, headers, options.headers || {});
    }
  }

  /**
   * Clears the resource timings and all resources assigned with spans
   *     when {@link FetchPluginConfig.clearTimingResources} is
   *     set to true (default false)
   * @private
   */
  private _clearResources() {
    if (this._tasksCount === 0 && this._getConfig().clearTimingResources) {
      performance.clearResourceTimings();
      this._usedResources = new WeakSet<PerformanceResourceTiming>();
    }
  }

  /**
   * Creates a new span
   * @param url
   * @param options
   */
  private _createSpan(
    url: string,
    options: Partial<Request | RequestInit> = {}
  ): api.Span | undefined {
    if (core.isUrlIgnored(url, this._getConfig().ignoreUrls)) {
      this._diag.debug('ignoring span as url matches ignored url');
      return;
    }
    const method = (options.method || 'GET').toUpperCase();
    const spanName = method;
    const parsedUrl = web.parseUrl(url);
    const host = this._getHostAttribute(parsedUrl);

    return this.tracer.startSpan(spanName, {
      kind: api.SpanKind.CLIENT,
      attributes: {
        [SemanticAttributes.HTTP_URL]: url,
        [SemanticAttributes.HTTP_METHOD]: method,
        [SemanticAttributes.HTTP_TARGET]: parsedUrl.pathname || '/',
        [SemanticAttributes.NET_PEER_NAME]: parsedUrl.hostname,
        [SemanticAttributes.HTTP_HOST]: host
      },
    });
  }

  /**
   * Finds appropriate resource and add network events to the span
   * @param span
   * @param resourcesObserver
   * @param endTime
   */
  private _findResourceAndAddNetworkEvents(
    span: api.Span,
    resourcesObserver: SpanData,
    endTime: api.HrTime
  ): void {
    let resources: PerformanceResourceTiming[] = resourcesObserver.entries;
    if (!resources.length) {
      if (!performance.getEntriesByType) {
        return;
      }
      // fallback - either Observer is not available or it took longer
      // then OBSERVER_WAIT_TIME_MS and observer didn't collect enough
      // information
      resources = performance.getEntriesByType(
        'resource'
      ) as PerformanceResourceTiming[];
    }
    const resource = web.getResource(
      resourcesObserver.spanUrl,
      resourcesObserver.startTime,
      endTime,
      resources,
      this._usedResources,
      'fetch'
    );

    if (resource.mainRequest) {
      const mainRequest = resource.mainRequest;
      this._markResourceAsUsed(mainRequest);

      const corsPreFlightRequest = resource.corsPreFlightRequest;
      if (corsPreFlightRequest) {
        this._addChildSpan(span, corsPreFlightRequest);
        this._markResourceAsUsed(corsPreFlightRequest);
      }
      if (!this._getConfig().ignoreNetworkEvents) {
        web.addSpanNetworkEvents(span, mainRequest);
      }
    }
  }

  /**
   * Marks certain [resource]{@link PerformanceResourceTiming} when information
   * from this is used to add events to span.
   * This is done to avoid reusing the same resource again for next span
   * @param resource
   */
  private _markResourceAsUsed(resource: PerformanceResourceTiming): void {
    this._usedResources.add(resource);
  }

  /**
   * Sets the span with the error passed in params
   * @param span the span that need to be set
   * @param error error that will be set to span
   */
  private _handleSpanWithError(span: api.Span, error: Error): void {
    const message = error.message;

    span.setAttributes({
      [AttributeNames.HTTP_ERROR_NAME]: error.name,
      [AttributeNames.HTTP_ERROR_MESSAGE]: message,
    });

    span.setStatus({ code: api.SpanStatusCode.ERROR, message });
    span.recordException(error);
  };

  /**
   * Finish span, add attributes, network events etc.
   * @param span
   * @param spanData
   * @param response
   */
  private _endSpan(
    span: api.Span,
    spanData: SpanData,
    response?: FetchResponse,
    error?: Error
  ) {
    const endTime = core.millisToHrTime(Date.now());
    const performanceEndTime = core.hrTime();
    if (response) {
      this._addFinalSpanAttributes(span, response);
    }
    if (error) {
      this._handleSpanWithError(span, error);
    }

    setTimeout(() => {
      spanData.observer?.disconnect();
      this._findResourceAndAddNetworkEvents(span, spanData, performanceEndTime);
      this._tasksCount--;
      this._clearResources();
      span.end(endTime);
    }, OBSERVER_WAIT_TIME_MS);
  }

  /**
   * Patches the constructor of fetch
   */
  private _patchConstructor(): (original: typeof fetch) => typeof fetch {
    return original => {
      const plugin = this;
      return function patchConstructor(
        this: typeof globalThis,
        ...args: Parameters<typeof fetch>
      ): Promise<Response> {
        const self = this;
        const url = web.parseUrl(
          args[0] instanceof Request ? args[0].url : String(args[0])
        ).href;

        const options = args[0] instanceof Request ? args[0] : args[1] || {};
        const createdSpan = plugin._createSpan(url, options);
        if (!createdSpan) {
          return original.apply(this, args);
        }
        plugin._applyAttributesBeforeFetch(createdSpan, options);
        const spanData = plugin._prepareSpanData(url);

        function endSpanOnError(span: api.Span, error: Error) {
          plugin._applyAttributesAfterFetch(span, error);
          plugin._endSpan(span, spanData, undefined, error);
        }

        function endSpanOnSuccess(span: api.Span, response: Response) {
          plugin._applyAttributesAfterFetch(span, response);
          if (response.status >= 200 && response.status < 400) {
            plugin._endSpan(span, spanData, response);
          } else {
            plugin._endSpan(span, spanData, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              url,
            });
          }
        }

        function onSuccess(
          span: api.Span,
          resolve: (value: Response | PromiseLike<Response>) => void,
          response: Response
        ): void {
          try {
            const resClone = response.clone();
            const resClone4Hook = response.clone();
            const body = resClone.body;
            if (body) {
              const reader = body.getReader();
              const read = (): void => {
                reader.read().then(
                  ({ done }) => {
                    if (done) {
                      endSpanOnSuccess(span, resClone4Hook);
                    } else {
                      read();
                    }
                  },
                  error => {
                    endSpanOnError(span, error);
                  }
                );
              };
              read();
            } else {
              // some older browsers don't have .body implemented
              endSpanOnSuccess(span, response);
            }
          } finally {
            resolve(response);
          }
        }

        function onError(
          span: api.Span,
          reject: (reason?: unknown) => void,
          error: Error
        ) {
          try {
            endSpanOnError(span, error);
          } finally {
            reject(error);
          }
        }

        return new Promise((resolve, reject) => {
          return api.context.with(
            api.trace.setSpan(api.context.active(), createdSpan),
            () => {
              plugin._addHeaders(options, url);
              plugin._tasksCount++;
              // TypeScript complains about arrow function captured a this typed as globalThis
              // ts(7041)
              return original
                .apply(
                  self,
                  options instanceof Request ? [options] : [url, options]
                )
                .then(
                  onSuccess.bind(self, createdSpan, resolve),
                  onError.bind(self, createdSpan, reject)
                );
            }
          );
        });
      };
    };
  }

  private _applyAttributesBeforeFetch(span: api.Span, request: Request | RequestInit) {
    const applyCustomAttributesOnReq =
      this._getConfig().applyCustomAttributesOnReq;
    if (applyCustomAttributesOnReq) {
      safeExecuteInTheMiddle(
        () => applyCustomAttributesOnReq(span, request),
        error => {
          if (!error) {
            return;
          }

          this._diag.error('applyCustomAttributesOnReq', error);
        },
        true
      );
    }
  }

  private _applyAttributesAfterFetch(span: api.Span, res: Response | Error) {
    const applyCustomAttributesOnRes =
      this._getConfig().applyCustomAttributesOnRes;
    if (applyCustomAttributesOnRes) {
      safeExecuteInTheMiddle(
        () => applyCustomAttributesOnRes(span, res),
        error => {
          if (!error) {
            return;
          }

          this._diag.error('applyCustomAttributesOnRes', error);
        },
        true
      );
    }
  }

  /**
   * Prepares a span data - needed later for matching appropriate network
   *     resources
   * @param spanUrl
   */
  private _prepareSpanData(spanUrl: string): SpanData {
    const startTime = core.hrTime();
    const entries: PerformanceResourceTiming[] = [];
    if (typeof PerformanceObserver !== 'function') {
      return { entries, startTime, spanUrl };
    }

    const observer = new PerformanceObserver(list => {
      const perfObsEntries = list.getEntries() as PerformanceResourceTiming[];
      perfObsEntries.forEach(entry => {
        if (entry.initiatorType === 'fetch' && entry.name === spanUrl) {
          entries.push(entry);
        }
      });
    });
    observer.observe({
      entryTypes: ['resource'],
    });
    return { entries, observer, startTime, spanUrl };
  }

  /**
   * implements enable function
   */
  override enable(): void {
    if (isWrapped(fetch)) {
      this._unwrap(_globalThis, 'fetch');
      this._diag.debug('removing previous patch for constructor');
    }
    this._wrap(_globalThis, 'fetch', this._patchConstructor());
  }

  /**
   * implements unpatch function
   */
  override disable(): void {
    this._unwrap(_globalThis, 'fetch');
    this._usedResources = new WeakSet<PerformanceResourceTiming>();
  }
}
