import { parseId } from "../src/lib/routeId";

test("parseId reads whole numbers", () => {
  expect(parseId("9100001")).toBe(9100001);
  expect(parseId("0")).toBe(0);
});

test.each(["abc", "12abc", "1.5", "-3", "", " 6", "0x6", "1e3", "99999999999999999999"])("parseId of %j is null", (s) => {
  expect(parseId(s)).toBeNull();
});

test("parseId of a missing param is null", () => {
  expect(parseId(undefined)).toBeNull();
});
