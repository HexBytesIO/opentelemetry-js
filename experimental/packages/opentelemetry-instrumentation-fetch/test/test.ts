import test from 'ava';
import { InMemorySpanExporter, SimpleSpanProcessor, WebTracerProvider, ReadableSpan } from '@opentelemetry/sdk-trace-web';
import { FetchInstrumentation } from '../src';
import { isWrapped } from '@opentelemetry/instrumentation';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import * as express from 'express';
import { Server } from 'http';

let server: Server;
const testPort = 15361;
const testUrl = `http://localhost:${testPort}`;
const errorPort = 41514;
const errorUrl = `http://localhost:${errorPort}`;

const instrumentation = new FetchInstrumentation({ ignoreNetworkEvents: true });
instrumentation.enable();
instrumentation.disable();

const memoryExporter = new InMemorySpanExporter();
const provider = new WebTracerProvider();
const contextManager = new AsyncHooksContextManager().enable();

provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
instrumentation.setTracerProvider(provider);
provider.register({ contextManager: contextManager });
instrumentation.enable();

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSpan() {
	await wait(500);
	const span = memoryExporter.getFinishedSpans().find(span => span.name === "GET");
	if (span === undefined) {
		throw new Error("fetch span not found");
	}
	return span;
}

async function getServer() {
	const app = express();
	const port = testPort;

	app.get('/', (req, res) => {
		res.send('Server: Got request from app');
	});

	app.all('*', (req, res) => {
		res.status(404).send('404 Not Found');
	});

	const newServer = await app.listen(port);
	return newServer;
}

function attributesShouldExist(t: any, span: ReadableSpan, attributes: string[]) {
	for (const att of attributes) {
		t.not(span.attributes[att], undefined, `attribute ${att} is missing from span`);
	}
}

function attributesShouldNotExist(t: any, span: ReadableSpan, attributes: string[]) {
	for (const att of attributes) {
		t.is(span.attributes[att], undefined, `attribute ${att} should not exist on span`);
	}
}

test.before("start server", async () => {
	server = await getServer();
})

test.after("close server", async () => {
	await server.close();
})

test.afterEach("reset previous spans", () => {
	memoryExporter.reset();
})

test.serial('enabling and disabling wrap', (t: any) => {
	t.is(isWrapped(fetch), true);
	instrumentation.disable();
	t.is(isWrapped(fetch), false);
	instrumentation.enable();
	t.is(isWrapped(fetch), true);
});

test.serial('span attributes', async (t: any) => {
	const res = await fetch(testUrl);
	const parsedRes = await res.text();
	t.is(typeof parsedRes, "string");

	const span = await getSpan();

	const attToExist = [
		"http.host", "http.method", "http.response_content_length_uncompressed",
		"http.status_code", "http.status_text", "http.target", "http.url", "net.peer.name"
	];
	attributesShouldExist(t, span, attToExist);

	const attToNotExist = [
		"http.user_agent", "http.scheme"
	];
	attributesShouldNotExist(t, span, attToNotExist);
});

test.serial('error span attributes and event', async (t: any) => {
	try {
		await fetch(errorUrl);
		t.fail("error fetch should not succeed");
	}
	catch {
		const span = await getSpan();

		const attToExist = ["http.error_message", "http.error_name"];
		attributesShouldExist(t, span, attToExist);

		t.not(span.events.length, 0, "Error event not found");
		const errorEvent = span.events[0];
		t.not(errorEvent.name, "0", "Error event named 'exception' not found");

		const errAttToExist = [
			"exception.message", "exception.stacktrace", "exception.type"
		];
		const errorAttributes = errorEvent.attributes;
		if (errorAttributes) {
			for (const att of errAttToExist) {
				t.not(errorAttributes[att], undefined, `attribute ${att} is missing from error event`);
			}
		}
		else t.fail("Error event does not have any attributes");
	}
});
