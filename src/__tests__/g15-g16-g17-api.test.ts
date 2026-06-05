/**
 * Tests for G15 (fetchBotGroups), G16 (getGroupInfo), G17 (searchSpaceMembers).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  fetchBotGroups,
  getGroupInfo,
  searchSpaceMembers,
} from "../octo/api.js";

describe("fetchBotGroups (G15)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns group list on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { group_no: "g1", name: "Group One" },
            { group_no: "g2", name: "Group Two" },
          ]),
        ),
    });

    const groups = await fetchBotGroups({
      apiUrl: "https://api.test",
      botToken: "tok",
    });
    expect(groups).toHaveLength(2);
    expect(groups[0].group_no).toBe("g1");
    expect(groups[1].name).toBe("Group Two");
  });

  it("returns empty array on API failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("server error"),
    });

    const groups = await fetchBotGroups({
      apiUrl: "https://api.test",
      botToken: "tok",
    });
    expect(groups).toEqual([]);
  });

  it("calls correct URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("[]"),
    });

    await fetchBotGroups({
      apiUrl: "https://api.test",
      botToken: "tok",
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/v1/bot/groups");
  });
});

describe("getGroupInfo (G16)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns group info on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            group_no: "g1",
            name: "My Group",
            owner_uid: "owner123",
            member_count: 42,
          }),
        ),
    });

    const info = await getGroupInfo({
      apiUrl: "https://api.test",
      botToken: "tok",
      groupNo: "g1",
    });
    expect(info.group_no).toBe("g1");
    expect(info.name).toBe("My Group");
    expect(info.owner_uid).toBe("owner123");
    expect(info.member_count).toBe(42);
  });

  it("throws on API failure with error body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("group not found"),
    });

    await expect(
      getGroupInfo({
        apiUrl: "https://api.test",
        botToken: "tok",
        groupNo: "nonexistent",
      }),
    ).rejects.toThrow("group not found");
  });

  it("calls correct URL with groupNo", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"group_no": "g1", "name": "Test"}'),
    });

    await getGroupInfo({
      apiUrl: "https://api.test///",
      botToken: "tok",
      groupNo: "abc123",
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/v1/bot/groups/abc123");
  });
});

describe("searchSpaceMembers (G17)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns members on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { uid: "u1", name: "Alice", robot: 0 },
            { uid: "u2", name: "BotX", robot: 1 },
          ]),
        ),
    });

    const members = await searchSpaceMembers({
      apiUrl: "https://api.test",
      botToken: "tok",
      keyword: "ali",
    });
    expect(members).toHaveLength(2);
    expect(members[0].name).toBe("Alice");
    expect(members[1].robot).toBe(1);
  });

  it("passes query parameters correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("[]"),
    });

    await searchSpaceMembers({
      apiUrl: "https://api.test",
      botToken: "tok",
      keyword: "alice",
      spaceId: "sp1",
      limit: 10,
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/v1/bot/space/members?");
    expect(url).toContain("keyword=alice");
    expect(url).toContain("space_id=sp1");
    expect(url).toContain("limit=10");
  });

  it("omits query string when no params provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("[]"),
    });

    await searchSpaceMembers({
      apiUrl: "https://api.test",
      botToken: "tok",
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://api.test/v1/bot/space/members");
  });

  it("throws on API failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("access denied"),
    });

    await expect(
      searchSpaceMembers({
        apiUrl: "https://api.test",
        botToken: "tok",
      }),
    ).rejects.toThrow("access denied");
  });
});
