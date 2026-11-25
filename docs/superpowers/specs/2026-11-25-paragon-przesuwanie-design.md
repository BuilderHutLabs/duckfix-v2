# Paragon: przesuwanie na żywo (projekt)

## Po co
Obecny tryb „Paragon” (kilka zdjęć, potem łączenie) psuje długie, jednolite i sklejone paragony:
- każdy kawałek jest przycinany jak cała kartka, choć środek paragonu nie ma górnego ani dolnego brzegu;
- zakładka jest szukana na ślepo (od 3 do 70% wysokości), więc powtarzające się linie dają złe dopasowanie;
- gdy nic nie pasuje, kawałki są ustawiane jeden pod drugim, z powtórzonymi liniami.

Użytkownik chce nagrywać paragon i dostać go automatycznie złożonego.

## Cele
- Jeden ruch: spust → powolne przesuwanie telefonu od góry do dołu paragonu → stop → gotowy, prosty, cały paragon.
- Brak dublowanych i brakujących linii, także na paragonie z samymi „1 szt. x 4,99”.
- Działa płynnie na słabym telefonie (Redmi kolegi).

## Poza zakresem
- Prostowanie pogniecionego albo mocno zwiniętego paragonu: paragon ma leżeć płasko.
- Paragon ułożony poziomo, przesuwanie w bok.
- Telefony bez aparatu na żywo (otwierają zwykły aparat telefonu, więc trybu „Paragon” tam nie ma, jak dziś).

## Czego unikać
- Zacinania podglądu.
- Wyniku po cichu zepsutego: lepiej powiedzieć „Wolniej” albo „Wróć trochę wyżej” niż złożyć paragon z dziurą.

## Rozważone sposoby
- **A. Przesuwanie na żywo (wybrane).** Śledzenie ruchu w trakcie i zapisywanie ostrych klatek co kawałek, ze znanym przesunięciem. Wynik od razu po zatrzymaniu.
- **B. Nagranie filmu, łączenie potem.** Odrzucone: dużo pamięci, przeglądarka wolno wyciąga klatki z filmu (zwłaszcza na iPhonie), użytkownik czeka, słaby telefon może się wysypać.
- **C. Poprawione zdjęcia** (półprzezroczysty dół poprzedniego zdjęcia do nałożenia). Odrzucone: dalej kilka zdjęć i ręczne celowanie.

## Jak to działa

### Na ekranie
- Tryb „Paragon” w aparacie. Podpowiedź: „Ustaw górę paragonu i naciśnij spust”.
- Po naciśnięciu spust zmienia się w czerwony kwadrat „Stop”, a podpowiedź mówi „Przesuwaj powoli w dół”.
- Z prawej strony rośnie miniaturka złożonego paragonu: od razu widać, że idzie dobrze.
- Za szybki ruch daje pomarańczową podpowiedź „Wolniej” i krótką wibrację.
- Zgubione śledzenie daje podpowiedź „Wróć trochę wyżej”. Klatki nie są dodawane, dopóki obraz znów nie zgodzi się z ostatnią zapisaną.
- Przy słabym świetle pojawia się podpowiedź o latarce (istniejący przycisk latarki).
- „Stop” kończy paragon: złożony paragon trafia do zrobionych zdjęć jako jedno zdjęcie (z miniaturką, jak dziś). Potem można robić dalsze zdjęcia albo nacisnąć „Gotowe”.
- „Gotowe” w trakcie nagrywania najpierw robi „Stop”, a potem działa jak dziś.
- Na ekranie przycinania paragon jest jedną stroną, z ramką na całym obrazie (można poprawić), z filtrem Auto.

### Śledzenie (kilkanaście razy na sekundę, na słabym telefonie rzadziej)
- Klatka z podglądu zmniejszona do ok. 200 px szerokości, w odcieniach szarości.
- Znalezienie lewego i prawego brzegu paragonu: paragon jest jaśniejszy od tła. Obraz jest skalowany tak, żeby paragon miał zawsze tę samą szerokość, więc przybliżanie i oddalanie telefonu nie psuje skali.
- Przesunięcie w pionie względem poprzedniej klatki szukane tylko w małym oknie (do ok. 35% wysokości): między dwiema klatkami ruch jest mały, więc powtarzające się linie nie mylą.
- Przesunięcia są sumowane w położenie na paragonie.

### Zapisywanie klatek
- Pierwsza klatka zapisywana przy naciśnięciu spustu, potem kolejna za każdym razem, gdy przybyło ok. 45% nowej wysokości, ostatnia przy „Stop”.
- Klatka w pełnej rozdzielczości podglądu (na słabym telefonie mniejsza), przycięta do paragonu i wyprostowana według lewego i prawego brzegu, zapisana jako JPEG razem ze swoim położeniem.
- Limit liczby klatek, żeby nie skończyła się pamięć. Przy limicie nagrywanie kończy się samo z komunikatem.

### Składanie
- Klatki ustawiane według zapisanych położeń. Każde połączenie dopasowywane jeszcze dokładnie w małym oknie wokół spodziewanego miejsca.
- Z każdej klatki brany jest środkowy pas (najostrzejszy, najmniej zniekształcony), a cięcie wypada w środku zakładki.
- Wynik: jeden wysoki JPEG o szerokości do 1240 px, jak dziś.

### Co znika
- Stary „Paragon” ze zdjęć po kolei (`receiptStep`, `composeReceipt`, osobne kawałki w `ScanCrop`) zostaje zastąpiony nowym. Tryb ma jedną drogę.

## Testy
- Testy na sztucznym długim paragonie (losowe „linie tekstu” plus długie serie identycznych linii): przesuwane okno z szumem, drobnym obrotem i zmianą skali. Złożony paragon ma mieć długość oryginału z dokładnością do 2%, bez powtórzonych i brakujących linii.
- Testy stanów ekranu: start, przesuwanie, „Wolniej”, zgubione śledzenie, stop, limit klatek.
- Na prawdziwym telefonie sprawdzają użytkownik i kolega (Redmi): długi paragon, sklejone paragony, słabe światło.

## Decyzje zostawione wykonawcy (moje wybory, do poprawienia)
- Dokładne progi (okno szukania 35%, nowa klatka co 45%, limit klatek) mają być dobrane na testach.
- Częstotliwość śledzenia na słabym telefonie: według istniejącego `nextLookDelay`, ale nie rzadziej niż ok. 4 razy na sekundę. Przy rzadszym śledzeniu podpowiedź „Wolniej” pojawia się wcześniej.
