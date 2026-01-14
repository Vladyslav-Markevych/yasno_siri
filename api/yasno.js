export const config = {
  runtime: "edge",
};

/**
 * In-memory fallback cache
 * key: groupId
 * value: { slots, updatedOn }
 */
const plannedCache = new Map();

// ---------- helpers ----------

const jsonCached = (body, { ttl = 300, etag } = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
      ...(etag ? { etag } : {}),
    },
  });

const etagFromGroup = (group) =>
  `"${group.updatedOn}_${group.today?.status}_${group.tomorrow?.status}"`;

const toTime = (m) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

const kyivNowMinutes = () => {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" })
  );
  return now.getHours() * 60 + now.getMinutes();
};

const statusPrefix = (status) => {
  switch (status) {
    case "EmergencyShutdowns":
      return "Действуют экстренные отключения. ";
    case "StabilizationShutdowns":
      return "Действуют стабилизационные отключения. ";
    default:
      return "";
  }
};

// ---------- handler ----------

export default async function handler(req) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("mode") || "schedule";
  const groupId = searchParams.get("group") || "5.2";

  const YASNO_URL =
    "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages";

  try {
    const res = await fetch(YASNO_URL, {
      headers: { accept: "application/json" },
    });

    const data = await res.json();
    const group = data[groupId];

    if (!group) {
      return jsonCached({ text: `Группа ${groupId} не найдена` });
    }

    const etag = etagFromGroup(group);

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    const nowMin = kyivNowMinutes();

    const todayStatus = group.today?.status;
    const todaySlotsRaw = group.today?.slots || [];

    const definitesToday = todaySlotsRaw.filter((s) => s.type === "Definite");

    // ---------- STORE LAST VALID PLANNED ----------
    if (definitesToday.length > 0 && todayStatus !== "EmergencyShutdowns") {
      plannedCache.set(groupId, {
        slots: definitesToday,
        updatedOn: group.updatedOn,
      });
    }

    // ---------- RESOLVE PLANNED SLOTS ----------
    let plannedSlots = definitesToday;
    let isFallback = false;

    if (
      todayStatus === "EmergencyShutdowns" &&
      plannedSlots.length === 0 &&
      plannedCache.has(groupId)
    ) {
      plannedSlots = plannedCache.get(groupId).slots;
      isFallback = true;
    }

    const prefix =
      statusPrefix(todayStatus) +
      (isFallback ? "По последнему плановому графику " : "");

    // ---------- schedule ----------
    if (mode === "schedule") {
      if (!plannedSlots.length) {
        return jsonCached(
          {
            text:
              statusPrefix(todayStatus) + "Плановый график временно недоступен",
          },
          { etag }
        );
      }

      const ranges = plannedSlots.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached(
        {
          text: prefix + `сегодня отключения ${ranges.join(" и ")}`,
        },
        { etag }
      );
    }

    // ---------- schedule_tomorrow ----------
    if (mode === "schedule_tomorrow") {
      const tomorrowStatus = group.tomorrow?.status;
      const tomorrowSlotsRaw = group.tomorrow?.slots || [];

      const definitesTomorrow = tomorrowSlotsRaw.filter(
        (s) => s.type === "Definite"
      );

      const tomorrowPrefix = statusPrefix(tomorrowStatus);

      // ❗️ Завтра нет планового графика
      if (!definitesTomorrow.length) {
        if (tomorrowStatus === "EmergencyShutdowns") {
          return jsonCached(
            {
              text: tomorrowPrefix + "Завтра плановый график не опубликован",
            },
            { etag }
          );
        }

        return jsonCached(
          {
            text: "Завтра отключений не запланировано",
          },
          { etag }
        );
      }

      const ranges = definitesTomorrow.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached(
        {
          text: tomorrowPrefix + `Завтра отключения ${ranges.join(" и ")}`,
        },
        { etag }
      );
    }

    // ---------- next ----------
    if (mode === "next") {
      const upcoming = plannedSlots
        .filter((s) => s.start > nowMin)
        .sort((a, b) => a.start - b.start);

      if (!upcoming.length) {
        return jsonCached(
          {
            text: prefix + "на сегодня отключений больше не ожидается",
          },
          { etag }
        );
      }

      const s = upcoming[0];

      return jsonCached(
        {
          text:
            prefix +
            `ближайшее отключение с ${toTime(s.start)} до ${toTime(s.end)}`,
        },
        { etag }
      );
    }

    // ---------- until_on ----------
    if (mode === "until_on") {
      const current = plannedSlots.find(
        (s) => s.start <= nowMin && s.end > nowMin
      );

      if (!current) {
        return jsonCached({ text: prefix + "сейчас свет есть" }, { etag });
      }

      const minutesLeft = current.end - nowMin;
      const h = Math.floor(minutesLeft / 60);
      const m = minutesLeft % 60;

      const waitText =
        h > 0 && m > 0 ? `${h} ч ${m} мин` : h > 0 ? `${h} ч` : `${m} мин`;

      return jsonCached(
        {
          text:
            prefix +
            `свет должны были включить в ${toTime(
              current.end
            )}, через ${waitText}`,
        },
        { etag }
      );
    }

    // ---------- off_at ----------
    if (mode === "off_at") {
      const upcoming = plannedSlots
        .filter((s) => s.start > nowMin)
        .sort((a, b) => a.start - b.start);

      if (!upcoming.length) {
        return jsonCached(
          {
            text: prefix + "отключений по графику больше не ожидается",
          },
          { etag }
        );
      }

      const next = upcoming[0];
      const minutesLeft = next.start - nowMin;

      const h = Math.floor(minutesLeft / 60);
      const m = minutesLeft % 60;

      const waitText =
        h > 0 && m > 0 ? `${h} ч ${m} мин` : h > 0 ? `${h} ч` : `${m} мин`;

      return jsonCached(
        {
          text:
            prefix +
            `должны были выключить в ${toTime(next.start)}, через ${waitText}`,
        },
        { etag }
      );
    }

    return jsonCached({ text: "Неизвестный режим" }, { etag });
  } catch {
    return new Response(JSON.stringify({ text: "Ошибка получения данных" }), {
      status: 500,
    });
  }
}
