export const config = {
  runtime: "edge",
};

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

const toTime = (m) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

const kyivNowMinutes = () => {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" })
  );
  return now.getHours() * 60 + now.getMinutes();
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

    // --- If-None-Match ---
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    const prefixToday = statusPrefix(group.today?.status);
    const prefixTomorrow = statusPrefix(group.tomorrow?.status);

    const todaySlots = group?.today?.slots || [];
    const tomorrowSlots = group?.tomorrow?.slots || [];

    const definitesToday = todaySlots.filter((s) => s.type === "Definite");
    const definitesTomorrow = tomorrowSlots.filter(
      (s) => s.type === "Definite"
    );

    const nowMin = kyivNowMinutes();

    // ---------- schedule (today) ----------
    if (mode === "schedule") {
      if (!definitesToday.length) {
        return jsonCached(
          { text: prefixToday + "Сегодня отключений нет" },
          { etag }
        );
      }

      const ranges = definitesToday.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached(
        {
          text: prefixToday + `Сегодня отключения ${ranges.join(" и ")}`,
        },
        { etag }
      );
    }

    // ---------- schedule tomorrow ----------
    if (mode === "schedule_tomorrow") {
      if (!definitesTomorrow.length) {
        return jsonCached(
          { text: prefixTomorrow + "Завтра отключений не запланировано" },
          { etag }
        );
      }

      const ranges = definitesTomorrow.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached(
        {
          text: prefixTomorrow + `Завтра отключения ${ranges.join(" и ")}`,
        },
        { etag }
      );
    }

    // ---------- next ----------
    if (mode === "next") {
      const upcoming = definitesToday
        .filter((s) => s.start > nowMin)
        .sort((a, b) => a.start - b.start);

      if (!upcoming.length) {
        return jsonCached(
          {
            text:
              prefixToday + "Сегодня отключений больше не ожидается",
          },
          { etag }
        );
      }

      const s = upcoming[0];

      return jsonCached(
        {
          text:
            prefixToday +
            `Ближайшее отключение с ${toTime(s.start)} до ${toTime(
              s.end
            )}`,
        },
        { etag }
      );
    }

    // ---------- until_on ----------
    if (mode === "until_on") {
      const current = definitesToday.find(
        (s) => s.start <= nowMin && s.end > nowMin
      );

      if (!current) {
        return jsonCached(
          { text: prefixToday + "Сейчас свет есть" },
          { etag }
        );
      }

      const minutesLeft = current.end - nowMin;
      const h = Math.floor(minutesLeft / 60);
      const m = minutesLeft % 60;

      const waitText =
        h > 0 && m > 0 ? `${h} ч ${m} мин` : h > 0 ? `${h} ч` : `${m} мин`;

      return jsonCached(
        {
          text:
            prefixToday +
            `По графику свет включат в ${toTime(
              current.end
            )}, через ${waitText}`,
        },
        { etag }
      );
    }

    // ---------- off_at ----------
    if (mode === "off_at") {
      const upcoming = definitesToday
        .filter((s) => s.start > nowMin)
        .sort((a, b) => a.start - b.start);

      if (!upcoming.length) {
        return jsonCached(
          {
            text:
              prefixToday + "Сегодня отключений больше не ожидается",
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
            prefixToday +
            `По графику должны выключить в ${toTime(
              next.start
            )}, через ${waitText}`,
        },
        { etag }
      );
    }

    return jsonCached({ text: "Неизвестный режим" }, { etag });
  } catch (e) {
    return new Response(
      JSON.stringify({ text: "Ошибка получения данных" }),
      { status: 500 }
    );
  }
}
