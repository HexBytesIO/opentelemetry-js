import test from 'ava';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { FetchInstrumentation } from '../src';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations, isWrapped } from '@opentelemetry/instrumentation';
// import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';

const provider = new WebTracerProvider();
const memoryExporter = new InMemorySpanExporter();
const contextManager = new ZoneContextManager().enable(); 
context.setGlobalContextManager(contextManager);
const tracer = provider.getTracer('default');

provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
provider.register({
  contextManager: contextManager,
});

const fetchInstrumentation = new FetchInstrumentation({ ignoreNetworkEvents: true });
registerInstrumentations({
  instrumentations: [fetchInstrumentation]
});

fetchInstrumentation.setTracerProvider(provider);
fetchInstrumentation.enable();

test('enabling and disabling wrap', (t: any) => {
	t.is(isWrapped(fetch), true);
	fetchInstrumentation.disable();
	t.is(isWrapped(fetch), false);
	fetchInstrumentation.enable();
	t.is(isWrapped(fetch), true);
});

test('successful fetching', async (t: any) => {
	const rootSpan = tracer.startSpan('rootSpan');
	await context.with(
		trace.setSpan(context.active(), rootSpan),
		async () => {
			fetchInstrumentation.enable();
			t.is(memoryExporter.getFinishedSpans().length, 0);
			const res = await fetch("http://wtfismyip.com/text", {headers: {"blip": "blop"}, method: "get"});
			const parsedRes = await res.text();
			t.is(typeof parsedRes, "string");
			rootSpan.end();
			t.not(memoryExporter.getFinishedSpans().length, 0);
			console.log(memoryExporter.getFinishedSpans().length);
			t.notDeepEqual(
				memoryExporter
				  .getFinishedSpans()
				  .find(span => span.name.includes('rootSpan')),
				undefined
			  );
		});
});
