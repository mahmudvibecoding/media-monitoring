# Names in the texts

The website marks the names of people, organizations, places and events in Telegram's messages: those labelled by hand in 1,000
posts that name finders are scored on, which admins correct there, and those models found in the same posts, compared
with them.

## The kinds

- **Person**: a person's name, whole or in part, a nickname, a stage name (Shavkat Mirziyoyev, Мирзиёев, King
  Macarella); not a role or title alone (Prezident, hokim, министр), nor groups or nationalities.
- **Organization**: anything run by someone, and everything built that has a name: companies, banks, government
  bodies, parties, international organizations, media, sports clubs and teams, universities, schools, hospitals;
  brands and products (Ucell, Uzcard, Humo, Payme, Nexia 3, iPhone 17); facilities and venues (Chorsu bozori, Humo
  Arena, airports, stations, power plants, factories, hotels, theatres, museums, parks, residential complexes).
- **Place**: where on the map: continents, countries, regions, cities, districts, villages, mahallas, streets, squares,
  roads, rivers, lakes, seas, mountains.
- **Event**: something that happens at a time and has a name: forums, summits, conferences, exhibitions; festivals and
  holidays (Navro'z); competitions, tournaments, championships, leagues as competitions (Chempionlar ligasi, Olimpiya
  o'yinlari); elections and referendums as a particular one; wars, battles, operations; expeditions, campaigns,
  marathons («Голиаф экспедицияси»). Not prizes (Nobel mukofoti), programmes (FLEX), nor a generic word without a name
  (forum, saylov).

Laws, titles of works, languages, religions, dates and money aren't names, but a person, organization or place named in
them is (AQSH dollari: AQSH, a place). A name is whole words, its ending included (Toshkentda, Mirziyoyevning); an
administrative word after a place's name is part of it (Samarqand viloyati); the longest name wins (Toshkent shahar
hokimligi is one organization, Toshkent xalqaro investitsiya forumi one event), and a role isn't part of one (AQSH
davlat kotibi: AQSH, a place). Names in links, @usernames and #hashtags, and in a channel's own signature and
subscription lines, aren't labelled.

## The labelled posts

The posts come from Telegram's big channels: 30,000 subscribers or more, in Uzbek or Russian, that posted after
September 15, 2026. Of the last 60 posts of each of the 1,954, those since September 1 of 200 to 1,800 characters
(66,082) were read by three models trained on Gemma's names (Glot500, XLM-V, MiniLM; 3 minutes on the A40), and the
posts kept that have 3 to 25 names and at most 2.5 in a hundred characters (not lists: fixtures, results, weather), no
phone number or betting (not ads), aren't Karakalpak and aren't a repeat: 13,407. Of those, at most 3 a channel and 80
about sport, in a set number for each script: first the 300 the models disagree on most, then, one at a time, the post
with the most names not yet in the set. 1,000 posts: 501 in Uzbek Latin, 290 in Uzbek Cyrillic, 209 in Russian, from 534
channels.

Claude labelled them by the rules above (9,809 names: 2,587 people, 3,497 organizations, 3,323 places and 402 events,
the events in a pass of their own), each placed in the text wherever it's written, as whole words, but not in links,
@usernames and #hashtags, nor in the post's signature lines when it's in the rest of it; where two overlap, the longer.
18 posts have none. They're in `app.telegram_message_labels` twice: as admins correct them on the website (`hand`), and
as Claude labelled them (`claude`), to see what was corrected; a message an admin marks checked keeps when
(`checked_at`), so that what's left to check shows. The chat list's labelled folder has their 534 channels, the posts
without names too.

## Gemma's names

Beside them, in the same table, the names Gemma 4 26B (INT8, on vLLM) found in the same posts, told the rules above. The
website compares them with the names labelled by hand as it shows them, by where they are: the same words of the same
kind are right; overlapping a name of the same kind, but not the same words, the boundaries differ; overlapping only a
name of another kind, the kind is wrong; overlapping none, it's extra; and a name labelled by hand that none of Gemma's
overlaps is missed.