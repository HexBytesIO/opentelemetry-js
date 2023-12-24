import test from 'ava';
import { ConsoleSpanExporter, SimpleSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { FetchInstrumentation } from '../src';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations, isWrapped } from '@opentelemetry/instrumentation';

const provider = new WebTracerProvider();

provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register({
  contextManager: new ZoneContextManager(),
});

const fetchInstrumentation = new FetchInstrumentation({ ignoreNetworkEvents: true });
registerInstrumentations({
  instrumentations: [fetchInstrumentation]
});

test('enabling and disabling wrap', (t: any) => {
	t.is(isWrapped(fetch), true);
	fetchInstrumentation.disable();
	t.is(isWrapped(fetch), false);
	fetchInstrumentation.enable();
	t.is(isWrapped(fetch), true);
});
