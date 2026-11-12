const echoMath = createAssistantEchoMath(null, createAssistantEchoReflection()).assistantEchoMath();
self.onmessage = ({ data }) => {
  if (data?.type !== 'train' || !Number.isSafeInteger(data.request) || data.request < 0) return;
  let result;
  try {
    result = echoMath.train(data.input);
  } catch {
    result = { status: 'UNKNOWN' };
  }
  self.postMessage({ type: 'fit', request: data.request, result });
};
self.postMessage({ type: 'ready', protocol: 1 });
