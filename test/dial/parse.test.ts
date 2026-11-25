// Parsing for DIAL, each case from the Chromium function it follows (see src/dial/parse.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appNameFromDialSource, buildSearchRequest, getDialAppUrl, isDialSource, isValidDeviceUrl, parseAppInfo,
  parseDeviceDescription, parseDialLaunchSource, parseSsdpResponse, processDeviceUuid,
} from "../../src/dial/parse.ts";
import { parseXml } from "../../src/dial/xml.ts";
import { dialOriginAllowed } from "../../src/dial/origins.ts";
import { APP_URL, DESCRIPTION_URL, DEVICE_IP, UDN, appInfoXml, descriptionXml, ssdpAnswer } from "./fixtures.ts";

test("an SSDP answer needs a LOCATION on the sender and a USN, and its ST is not checked", () => {
  const d = parseSsdpResponse(ssdpAnswer(), DEVICE_IP, 1000);
  assert.deepEqual(d, {
    deviceId: `${UDN}::urn:dial-multiscreen-org:service:dial:1`, label: "", ipAddress: DEVICE_IP,
    descriptionUrl: DESCRIPTION_URL, responseTime: 1000, maxAge: 1800, configId: null,
  });
  assert.equal(parseSsdpResponse(ssdpAnswer(), "192.168.1.99", 0), null, "LOCATION must name the sender");
  assert.equal(parseSsdpResponse(ssdpAnswer({ location: "http://8.8.8.8/d.xml" }), "8.8.8.8", 0), null, "public address");
  assert.equal(parseSsdpResponse(ssdpAnswer({ location: "http://printer.local/d.xml" }), DEVICE_IP, 0), null, "host name");
  assert.equal(parseSsdpResponse(ssdpAnswer({ location: "ftp://192.168.1.20/d.xml" }), DEVICE_IP, 0), null, "scheme");
  assert.equal(parseSsdpResponse(ssdpAnswer({ usn: null }), DEVICE_IP, 0), null, "USN");
  assert.equal(parseSsdpResponse("HTTP/1.1 200 OK\r\nUSN: x\r\n", DEVICE_IP, 0), null, "incomplete headers");
  const otherSt = ssdpAnswer().replace("ST: urn:dial-multiscreen-org:service:dial:1", "ST: upnp:other");
  assert.equal(parseSsdpResponse(otherSt, DEVICE_IP, 0)?.ipAddress, DEVICE_IP);
});

test("max-age is capped at 3600 and CONFIGID must be in range", () => {
  const hour = parseSsdpResponse(ssdpAnswer().replace("max-age=1800", "max-age=99999"), DEVICE_IP, 0);
  assert.equal(hour?.maxAge, 3600);
  assert.equal(parseSsdpResponse(ssdpAnswer({ extra: "CONFIGID.UPNP.ORG: 42" }), DEVICE_IP, 0)?.configId, 42);
  assert.equal(parseSsdpResponse(ssdpAnswer({ extra: "CONFIGID.UPNP.ORG: 0" }), DEVICE_IP, 0)?.configId, null);
  assert.equal(parseSsdpResponse(ssdpAnswer({ extra: "CONFIGID.UPNP.ORG: 99999999" }), DEVICE_IP, 0)?.configId, null);
});

test("the M-SEARCH request is Chromium's", () => {
  assert.equal(
    buildSearchRequest("Chrome/1 Windows"),
    "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n"
    + "ST: urn:dial-multiscreen-org:service:dial:1\r\nUSER-AGENT: Chrome/1 Windows\r\n\r\n",
  );
});

test("device URLs must be private http(s) addresses equal to the sender", () => {
  assert.ok(isValidDeviceUrl("http://10.0.0.5:8008/a", "10.0.0.5"));
  assert.ok(isValidDeviceUrl("https://127.0.0.1/a", "127.0.0.1"));
  assert.ok(!isValidDeviceUrl("http://10.0.0.5/a", "10.0.0.6"));
  assert.ok(!isValidDeviceUrl("http://93.184.216.34/a", "93.184.216.34"));
});

test("a device description gives UDN, name and model, and falls back to model plus the UDN's last four", () => {
  const good = parseDeviceDescription(descriptionXml(), APP_URL, DEVICE_IP);
  assert.deepEqual(good, { ok: true, value: {
    uniqueId: UDN, friendlyName: "Living Room TV", modelName: "Smart TV",
    deviceType: "urn:dial-multiscreen-org:device:dial:1", appUrl: APP_URL,
  } });
  const unnamed = parseDeviceDescription(descriptionXml().replace("<friendlyName>Living Room TV</friendlyName>", ""), APP_URL, DEVICE_IP);
  assert.equal(unnamed.ok && unnamed.value.friendlyName, "Smart TV [7777]");
  const noUdn = descriptionXml().replace(`<UDN>${UDN}</UDN>`, "");
  assert.deepEqual(parseDeviceDescription(noUdn, APP_URL, DEVICE_IP), { ok: false, error: "missing_unique_id" });
  assert.deepEqual(parseDeviceDescription(descriptionXml(), "", DEVICE_IP), { ok: false, error: "missing_app_url" });
  assert.deepEqual(parseDeviceDescription(descriptionXml(), "http://10.9.9.9/apps", DEVICE_IP), { ok: false, error: "invalid_app_url" });
  assert.deepEqual(parseDeviceDescription("<root><device>", APP_URL, DEVICE_IP), { ok: false, error: "invalid_xml" });
  assert.deepEqual(parseDeviceDescription("<other/>", APP_URL, DEVICE_IP), { ok: false, error: "invalid_xml" });
});

test("app info needs a name and a running or stopped state, in any case", () => {
  const info = parseAppInfo(appInfoXml("running", "<additionalData><screenId>abc</screenId><theme>dark</theme></additionalData>"));
  assert.deepEqual(info, {
    dialVersion: "2.1", name: "YouTube", allowStop: true, state: "running", href: "run",
    extraData: { screenId: "abc", theme: "dark" },
  });
  assert.equal(parseAppInfo(appInfoXml("stopped").replace("stopped", "STOPPED"))?.state, "stopped");
  assert.equal(parseAppInfo(appInfoXml("installable")), null, "an unknown state is invalid");
  assert.equal(parseAppInfo("<service><state>running</state></service>"), null, "no name");
  assert.equal(parseAppInfo(appInfoXml().replace('allowStop="true"', 'allowStop="false"'))?.allowStop, false);
  assert.equal(parseAppInfo("not xml"), null);
});

test("the XML reader refuses entity declarations and unknown entities, and reads CDATA and references", () => {
  assert.equal(parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), null);
  assert.equal(parseXml("<a>&nope;</a>"), null);
  assert.equal(parseXml("<a><b></a>"), null);
  assert.equal(parseXml("<a>1</a><b/>"), null);
  assert.equal(parseXml("<a>&lt;&#65;&#x42;</a>")?.text, "<AB");
  assert.equal(parseXml("<a><![CDATA[<raw>]]></a>")?.text, "<raw>");
  assert.equal(parseXml("<x:a xmlns:x='u'><x:b>t</x:b></x:a>")?.children[0]?.name, "b");
});

test("sink ids drop uuid: and dashes and lower-case", () => {
  assert.equal(processDeviceUuid("uuid:AAAA-BB-cc"), "aaaabbcc");
  assert.equal(processDeviceUuid(""), "");
});

test("cast-dial sources: app name, client id and the raw post data", () => {
  const src = "cast-dial:YouTube?dialPostData=pairingCode%3Dx&clientId=c1";
  assert.ok(isDialSource(src));
  assert.equal(appNameFromDialSource(src), "YouTube");
  assert.deepEqual(parseDialLaunchSource(src), { appName: "YouTube", clientId: "c1", postData: "pairingCode%3Dx" });
  assert.equal(parseDialLaunchSource("cast-dial:YouTube?dialPostData=x"), null, "clientId is required");
  assert.equal(parseDialLaunchSource("cast-dial:Tube?clientId=a&clientId=b")?.clientId, "b", "the last repeated key wins");
  assert.equal(parseDialLaunchSource("cast-dial:Tube?clientId=a")?.postData, null);
  assert.equal(appNameFromDialSource("cast-dial:../x"), "", "an app name cannot climb out of the app URL");
  assert.ok(!isDialSource("cast:233637DE"));
  assert.equal(getDialAppUrl(APP_URL, "YouTube"), `${APP_URL}/YouTube`);
  assert.equal(getDialAppUrl(`${APP_URL}/`, "YouTube"), `${APP_URL}/YouTube`);
  assert.equal(getDialAppUrl(APP_URL, "a/b"), null);
});

test("the origin allowlist applies to the apps Chrome lists, case-insensitively", () => {
  assert.ok(dialOriginAllowed("YouTube", "https://music.youtube.com"));
  assert.ok(dialOriginAllowed("youtube", "https://www.youtube.com"));
  assert.ok(!dialOriginAllowed("YouTube", "https://evil.example"));
  assert.ok(dialOriginAllowed("MyApp", "https://anything.example"), "an app that is not listed is open");
  assert.ok(!dialOriginAllowed("Netflix", "https://www.youtube.com"));
});
