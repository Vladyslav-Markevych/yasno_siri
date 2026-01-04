export const config = {
  runtime: "edge",
};

const jsonCached = (body, ttl = 300) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
    },
  });

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
      return jsonCached({
        text: `Группа ${groupId} не найдена`,
      });
    }

    const slots = group?.today?.slots || [];

    const toTime = (m) =>
      `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" })
    );

    const nowMin = now.getHours() * 60 + now.getMinutes();

    const definites = slots.filter((s) => s.type === "Definite");

    // --- ГРАФИК ---
    if (mode === "schedule") {
      if (!definites.length) {
        return jsonCached({ text: "Сегодня отключений нет" });
      }

      const ranges = definites.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached({
        text: `Сегодня отключения ${ranges.join(" и ")}`,
      });
    }

    // --- ГРАФИК ---
    if (mode === "schedule") {
      if (!definites.length) {
        return jsonCached({ text: "Сегодня отключений нет" });
      }

      const ranges = definites.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached({
        text: `Сегодня отключения ${ranges.join(" и ")}`,
      });
    }

    // --- ГРАФИК НА ЗАВТРА ---
    if (mode === "schedule_tomorrow") {
      const tomorrowSlots = group?.tomorrow?.slots || [];
      const tomorrowDefinites = tomorrowSlots.filter(
        (s) => s.type === "Definite"
      );

      if (!tomorrowDefinites.length) {
        return jsonCached({
          text: "Завтра отключений не запланировано",
        });
      }

      const ranges = tomorrowDefinites.map(
        (s) => `с ${toTime(s.start)} до ${toTime(s.end)}`
      );

      return jsonCached({
        text: `Завтра отключения ${ranges.join(" и ")}`,
      });
    }

    // --- БЛИЖАЙШЕЕ ОТКЛЮЧЕНИЕ ---
    if (mode === "next") {
      const upcoming = definites.filter((s) => s.start > nowMin);

      if (!upcoming.length) {
        return jsonCached({
          text: "Сегодня отключений больше не ожидается",
        });
      }

      upcoming.sort((a, b) => a.start - b.start);
      const s = upcoming[0];

      return jsonCached({
        text: `Ближайшее отключение с ${toTime(s.start)} до ${toTime(s.end)}`,
      });
    }

    // --- КОГДА ВКЛЮЧАТ СВЕТ ---
    if (mode === "until_on") {
      const current = definites.find(
        (s) => s.start <= nowMin && s.end > nowMin
      );

      if (!current) {
        return jsonCached({
          text: "Сейчас свет есть",
        });
      }

      const minutesLeft = current.end - nowMin;

      const h = Math.floor(minutesLeft / 60);
      const m = minutesLeft % 60;

      const waitText =
        h > 0 && m > 0 ? `${h} ч ${m} мин` : h > 0 ? `${h} ч` : `${m} мин`;

      const endTime = toTime(current.end);

      return jsonCached({
        text: `Свет включат в ${endTime}, через ${waitText}`,
      });
    }

    // --- КОГДА ВЫКЛЮЧАТ СВЕТ ---
    if (mode === "off_at") {
      const upcoming = definites
        .filter((s) => s.start > nowMin)
        .sort((a, b) => a.start - b.start);

      if (!upcoming.length) {
        return jsonCached({
          text: "Сегодня отключений больше не ожидается",
        });
      }

      const next = upcoming[0];
      const minutesLeft = next.start - nowMin;

      const h = Math.floor(minutesLeft / 60);
      const m = minutesLeft % 60;

      const timeText = toTime(next.start);

      const waitText =
        h > 0 && m > 0 ? `${h} ч ${m} мин` : h > 0 ? `${h} ч` : `${m} мин`;

      return jsonCached({
        text: `Выключат в ${timeText}, через ${waitText}`,
      });
    }

    return jsonCached({ text: "Неизвестный режим" });
  } catch (e) {
    return new Response(JSON.stringify({ text: "Ошибка получения данных" }), {
      status: 500,
    });
  }
}
