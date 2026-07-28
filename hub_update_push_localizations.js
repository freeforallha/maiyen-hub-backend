"use strict";

const HUB_UPDATE_PUSH_TEXTS = Object.freeze({"vi":["Cập nhật Hub","Phiên bản {release} đã sẵn sàng.","Bản cập nhật quan trọng"],"en":["Hub update","Version {release} is ready.","Critical update"],"zh":["Hub 更新","版本 {release} 已可用。","重要更新"],"ko":["Hub 업데이트","버전 {release}을 사용할 수 있습니다.","중요 업데이트"],"ja":["Hubの更新","バージョン{release}を利用できます。","重要な更新"],"de":["Hub-Update","Version {release} ist verfügbar.","Kritisches Update"],"ru":["Обновление Hub","Доступна версия {release}.","Критическое обновление"],"fr":["Mise à jour du Hub","La version {release} est disponible.","Mise à jour critique"],"es":["Actualización del Hub","La versión {release} está disponible.","Actualización crítica"],"id":["Pembaruan Hub","Versi {release} tersedia.","Pembaruan penting"],"th":["อัปเดต Hub","เวอร์ชัน {release} พร้อมใช้งานแล้ว","การอัปเดตสำคัญ"],"ms":["Kemas kini Hub","Versi {release} tersedia.","Kemas kini kritikal"],"fil":["Update ng Hub","Handa na ang bersyong {release}.","Mahalagang update"],"km":["អាប់ដេត Hub","កំណែ {release} បានរួចរាល់។","អាប់ដេតសំខាន់"],"my":["Hub အပ်ဒိတ်","ဗားရှင်း {release} အသင့်ဖြစ်ပါပြီ။","အရေးကြီးအပ်ဒိတ်"],"lo":["ອັບເດດ Hub","ເວີຊັນ {release} ພ້ອມໃຊ້ງານ.","ອັບເດດສຳຄັນ"],"ta":["Hub புதுப்பிப்பு","பதிப்பு {release} தயாராக உள்ளது.","முக்கிய புதுப்பிப்பு"],"pt":["Atualização do Hub","A versão {release} está disponível.","Atualização crítica"],"tet":["Atualiza Hub","Versaun {release} prontu ona.","Atualizasaun importante"],"it":["Aggiornamento Hub","La versione {release} è disponibile.","Aggiornamento critico"],"pl":["Aktualizacja Hub","Wersja {release} jest dostępna.","Aktualizacja krytyczna"],"nl":["Hub-update","Versie {release} is beschikbaar.","Kritieke update"],"cs":["Aktualizace Hubu","Verze {release} je k dispozici.","Kritická aktualizace"],"sk":["Aktualizácia Hubu","Verzia {release} je k dispozícii.","Kritická aktualizácia"],"uk":["Оновлення Hub","Доступна версія {release}.","Критичне оновлення"],"ro":["Actualizare Hub","Versiunea {release} este disponibilă.","Actualizare critică"],"hu":["Hub frissítése","A(z) {release} verzió elérhető.","Kritikus frissítés"],"bg":["Актуализация на Hub","Версия {release} е налична.","Критична актуализация"],"hr":["Ažuriranje Huba","Dostupna je verzija {release}.","Kritično ažuriranje"],"sr":["Ažuriranje Huba","Dostupna je verzija {release}.","Kritično ažuriranje"],"bs":["Ažuriranje Huba","Dostupna je verzija {release}.","Kritično ažuriranje"],"sl":["Posodobitev Huba","Različica {release} je na voljo.","Kritična posodobitev"],"mk":["Ажурирање на Hub","Достапна е верзијата {release}.","Критично ажурирање"],"sq":["Përditësimi i Hub-it","Versioni {release} është gati.","Përditësim kritik"],"el":["Ενημέρωση Hub","Η έκδοση {release} είναι διαθέσιμη.","Κρίσιμη ενημέρωση"],"tr":["Hub güncellemesi","{release} sürümü hazır.","Kritik güncelleme"],"sv":["Hub-uppdatering","Version {release} är tillgänglig.","Kritisk uppdatering"],"da":["Hub-opdatering","Version {release} er tilgængelig.","Kritisk opdatering"],"nb":["Hub-oppdatering","Versjon {release} er tilgjengelig.","Kritisk oppdatering"],"fi":["Hubin päivitys","Versio {release} on saatavilla.","Kriittinen päivitys"],"isLang":["Uppfærsla Hub","Útgáfa {release} er tiltæk.","Mikilvæg uppfærsla"],"et":["Hubi värskendus","Versioon {release} on saadaval.","Kriitiline värskendus"],"lv":["Hub atjauninājums","Ir pieejama versija {release}.","Kritisks atjauninājums"],"lt":["Hub atnaujinimas","Pasiekiama versija {release}.","Kritinis atnaujinimas"],"ga":["Nuashonrú Hub","Tá leagan {release} ar fáil.","Nuashonrú criticiúil"],"mt":["Aġġornament tal-Hub","Il-verżjoni {release} hija disponibbli.","Aġġornament kritiku"],"be":["Абнаўленне Hub","Даступная версія {release}.","Крытычнае абнаўленне"],"lb":["Hub-Aktualiséierung","Versioun {release} ass verfügbar.","Kritesch Aktualiséierung"],"ca":["Actualització del Hub","La versió {release} està disponible.","Actualització crítica"],"cnr":["Ažuriranje Huba","Dostupna je verzija {release}.","Kritično ažuriranje"],"hy":["Hub-ի թարմացում","{release} տարբերակը հասանելի է։","Կարևոր թարմացում"],"ka":["Hub-ის განახლება","ხელმისაწვდომია ვერსია {release}.","კრიტიკული განახლება"],"az":["Hub yeniləməsi","{release} versiyası hazırdır.","Kritik yeniləmə"]});

function normalizeHubUpdateLanguageCode(rawCode) {
  const value = String(rawCode || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  if (Object.prototype.hasOwnProperty.call(HUB_UPDATE_PUSH_TEXTS, value)) {
    return value;
  }

  const baseCode = value.split("-")[0];

  if (Object.prototype.hasOwnProperty.call(HUB_UPDATE_PUSH_TEXTS, baseCode)) {
    return baseCode;
  }

  return "vi";
}

function getHubUpdatePushText({
  languageCode,
  releaseId,
  critical = false,
  homeName = "",
}) {
  const code = normalizeHubUpdateLanguageCode(languageCode);
  const values = HUB_UPDATE_PUSH_TEXTS[code] || HUB_UPDATE_PUSH_TEXTS.vi;
  const sectionTitle = values[0];
  const availableTemplate = values[1];
  const criticalTitle = values[2];
  const cleanReleaseId = String(releaseId || "").trim();

  return {
    languageCode: code,
    title: critical
      ? `${criticalTitle}: ${cleanReleaseId}`
      : availableTemplate.replace("{release}", cleanReleaseId),
    body: String(homeName || "").trim() || sectionTitle,
  };
}

module.exports = {
  HUB_UPDATE_PUSH_TEXTS,
  getHubUpdatePushText,
  normalizeHubUpdateLanguageCode,
};
