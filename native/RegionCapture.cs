// native/RegionCapture.cs
// ------------------------
// Serveur de capture d'ecran par region, pilote en ligne de commande.
//
// Pourquoi ce processus separe
// ----------------------------
// Electron ne sait capturer que des ecrans entiers. `desktopCapturer.getSources`
// coute ~197 ms par appel (dont 168 ms de pure enumeration) et le flux
// `getUserMedia` persistant force le DWM a recomposer le jeu en continu. Les deux
// paient le prix d'une image plein ecran alors que l'infobulle tient dans
// ~900x220 px autour du curseur.
//
// `BitBlt` sur le contexte d'affichage du bureau lit exactement le rectangle
// demande, et rien d'autre. Cout attendu : quelques millisecondes, sans flux
// permanent ni duplication d'ecran.
//
// Pourquoi C# et non un module natif Node
// ---------------------------------------
// `csc.exe` est livre avec le .NET Framework, present sur toute installation de
// Windows depuis 8. Zero outil a installer : ni CMake, ni Visual Studio Build
// Tools, ni node-gyp, ni recompilation a chaque version d'Electron. Le projet
// conserve sa propriete « aucune dependance native a compiler par
// l'utilisateur ».
//
// Protocole
// ---------
// Le processus est lance **une fois** et reste vivant : on ne paie jamais le
// demarrage d'un processus par capture.
//
//   requete  (stdin, texte)   : "x y w h\n"   coordonnees ecran virtuel, pixels physiques
//   reponse  (stdout, binaire): int32 little-endian = nombre d'octets, puis les octets
//                               Payload = w*h*4 en BGRA, lignes du haut vers le bas.
//                               Une longueur de 0 signale un echec de capture.
//
//   requete  : "info\n"
//   reponse  : meme en-tete, payload UTF-8 — une ligne "x y w h primaire" par
//              moniteur, en pixels physiques.
//
// Pourquoi `info` existe
// ----------------------
// Electron raisonne en pixels **logiques**, avec un facteur d'echelle propre a
// chaque ecran ; ce processus raisonne en pixels physiques. Sur une
// configuration a facteurs melanges — mesure chez l'utilisateur : un 3840x2160
// a 150 % encadre de deux 1920x1080 a 100 % — les deux reperes ne se deduisent
// pas l'un de l'autre par une simple multiplication, et Electron n'expose pas
// l'origine physique de ses ecrans. Seul le systeme connait les deux ; on la lui
// demande donc, au lieu de la supposer.
//
// Le format BGRA descendant est celui qu'attend deja le reste du pipeline
// (`TooltipLocator`, `IconHash`), donc aucune conversion cote Node.
//
// Limite connue : un jeu en plein ecran **exclusif** n'est pas lisible par
// `BitBlt` — le bureau n'est alors plus compose. C'est la meme limite que pour
// l'overlay lui-meme, qui ne peut pas s'afficher par-dessus. Le mode borderless,
// seul supporte de toute facon, fonctionne.

using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

internal static class RegionCapture
{
    private const uint SRCCOPY = 0x00CC0020;

    // Inclut les fenetres « layered » (superposees) dans la copie. Sans ce
    // drapeau, tout ce qui est dessine avec WS_EX_LAYERED est absent de l'image.
    private const uint CAPTUREBLT = 0x40000000;

    private const int BI_RGB = 0;
    private const uint DIB_RGB_COLORS = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public int bmiColors;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    private const uint MONITORINFOF_PRIMARY = 1;

    /// <summary>
    /// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`. Sous ce mode, et lui seul,
    /// les rectangles de moniteurs et le repere de `GetDC(NULL)` sont exprimes en
    /// pixels physiques reels — y compris quand les ecrans n'ont pas le meme
    /// facteur d'echelle. `SetProcessDPIAware()` ne donne que la conscience DPI
    /// **systeme** : les ecrans dont le facteur differe de celui du bureau y sont
    /// rapportes etires, et les captures seraient decalees.
    /// </summary>
    private static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateDIBSection(
        IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool BitBlt(
        IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool StretchBlt(
        IntPtr dest, int x, int y, int w, int h,
        IntPtr src, int sx, int sy, int sw, int sh, uint rop);

    [DllImport("gdi32.dll")]
    private static extern int SetStretchBltMode(IntPtr hdc, int mode);

    [DllImport("gdi32.dll")]
    private static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr point);

    /**
     * Mode de reduction par moyennage. Les trois autres modes se contentent de
     * jeter des pixels, ce qui detruirait le texte fin d'une infobulle : un
     * caractere de 2 px de trait disparaitrait une fois sur deux.
     */
    private const int HALFTONE = 4;

    // --- Ressources GDI reutilisees d'une capture a l'autre ---
    //
    // Recreer un DIB par capture couterait plus cher que la copie elle-meme. On
    // ne le reconstruit que lorsque la taille demandee change, ce qui n'arrive
    // qu'au changement de resolution ou de reglage de fenetre de recherche.
    private static IntPtr screenDc = IntPtr.Zero;
    private static IntPtr memoryDc = IntPtr.Zero;
    private static IntPtr bitmap = IntPtr.Zero;
    private static IntPtr previous = IntPtr.Zero;
    private static IntPtr pixels = IntPtr.Zero;
    private static int bufferWidth;
    private static int bufferHeight;
    private static byte[] transfer = new byte[0];

    /// <summary>
    /// Drapeau ajoute a SRCCOPY. Voir <see cref="CAPTUREBLT"/> : il est actif par
    /// defaut et desactivable par `--no-captureblt`, ce qui exclut de la capture
    /// les fenetres superposees — dont la carte de prix de l'outil lui-meme.
    /// </summary>
    private static uint extraRop = CAPTUREBLT;

    private static int Main(string[] args)
    {
        foreach (string arg in args)
        {
            if (arg == "--no-captureblt") extraRop = 0;
        }

        // Sans cela, Windows ment sur les coordonnees et la taille sur un ecran
        // a mise a l'echelle : on capturerait un rectangle decale et etire.
        // `SetProcessDpiAwarenessContext` n'existe qu'a partir de Windows 10
        // 1703 ; sur plus ancien on retombe sur la conscience DPI systeme, qui
        // suffit tant que tous les ecrans partagent le meme facteur.
        try
        {
            if (!SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)) SetProcessDPIAware();
        }
        catch
        {
            try { SetProcessDPIAware(); } catch { }
        }

        Stream output = Console.OpenStandardOutput();
        TextReader input = Console.In;

        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line.Trim() == "info")
            {
                WriteInfo(output);
                continue;
            }

            int x, y, w, h, dw, dh;
            if (!Parse(line, out x, out y, out w, out h, out dw, out dh))
            {
                WriteLength(output, 0);
                continue;
            }

            int produced = Capture(x, y, w, h, dw, dh);
            if (produced <= 0)
            {
                WriteLength(output, 0);
                continue;
            }

            WriteLength(output, produced);
            output.Write(transfer, 0, produced);
            output.Flush();
        }

        Release();
        return 0;
    }

    /// <summary>
    /// Decoupe "x y w h" ou "x y w h dw dh". Les deux dernieres valeurs donnent
    /// la taille voulue en sortie ; absentes, elles valent la taille source.
    /// Retourne false sur toute entree douteuse.
    /// </summary>
    private static bool Parse(string line, out int x, out int y, out int w, out int h, out int dw, out int dh)
    {
        x = y = w = h = dw = dh = 0;
        string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 4 && parts.Length != 6) return false;

        NumberStyles style = NumberStyles.AllowLeadingSign;
        CultureInfo culture = CultureInfo.InvariantCulture;
        if (!int.TryParse(parts[0], style, culture, out x)) return false;
        if (!int.TryParse(parts[1], style, culture, out y)) return false;
        if (!int.TryParse(parts[2], style, culture, out w)) return false;
        if (!int.TryParse(parts[3], style, culture, out h)) return false;

        if (parts.Length == 6)
        {
            if (!int.TryParse(parts[4], style, culture, out dw)) return false;
            if (!int.TryParse(parts[5], style, culture, out dh)) return false;
        }
        else
        {
            dw = w;
            dh = h;
        }

        // Borne haute : une region plein ecran 8K reste sous cette limite, une
        // valeur aberrante due a un bug d'appelant est rejetee avant d'allouer.
        if (w <= 0 || h <= 0 || w > 16384 || h > 16384) return false;
        if (dw <= 0 || dh <= 0 || dw > w || dh > h) return false;
        return true;
    }

    /// <summary>
    /// Copie le rectangle demande dans <see cref="transfer"/>.
    /// </summary>
    /// <returns>Nombre d'octets ecrits, ou 0 en cas d'echec.</returns>
    private static int Capture(int x, int y, int w, int h, int dw, int dh)
    {
        if (!EnsureBuffers(dw, dh)) return 0;

        bool copied;
        if (dw == w && dh == h)
        {
            copied = BitBlt(memoryDc, 0, 0, w, h, screenDc, x, y, SRCCOPY | extraRop);
        }
        else
        {
            // Reduction pendant la copie, et non apres.
            //
            // Capturer en 4K natif puis reduire cote Node ferait payer le plein
            // tarif a tout le pipeline : transfert, remplissage de l'alpha,
            // construction de l'image, sous-echantillonnage du localisateur. La
            // reduction ici divise le travail de tous ces postes d'un coup, sans
            // rien couter a l'OCR — le texte est de toute facon ré-agrandi
            // ensuite pour atteindre la taille ou Tesseract est le meilleur.
            SetStretchBltMode(memoryDc, HALFTONE);
            // Exige par la documentation apres HALFTONE, faute de quoi la trame
            // se decale et introduit un motif regulier dans l'image reduite.
            SetBrushOrgEx(memoryDc, 0, 0, IntPtr.Zero);
            copied = StretchBlt(memoryDc, 0, 0, dw, dh, screenDc, x, y, w, h, SRCCOPY | extraRop);
        }

        if (!copied)
        {
            // Un echec vient presque toujours d'un DC devenu invalide apres un
            // changement de resolution ou de session. On repart de zero : la
            // capture suivante reconstruira tout.
            Release();
            return 0;
        }

        int bytes = dw * dh * 4;
        Marshal.Copy(pixels, transfer, 0, bytes);

        // GDI laisse l'octet alpha a zero : il ne gere pas la transparence sur un
        // DIB 32 bits, il se contente d'ignorer ce canal. Transmis tel quel,
        // `nativeImage.createFromBitmap` cote Electron lirait une image
        // **entierement transparente** et tout le pipeline recevrait du noir.
        // Cout mesure : ~0,2 ms pour 900x220.
        for (int i = 3; i < bytes; i += 4) transfer[i] = 255;

        return bytes;
    }

    /// <summary>Alloue ou reutilise les ressources GDI pour une taille donnee.</summary>
    private static bool EnsureBuffers(int w, int h)
    {
        if (screenDc != IntPtr.Zero && bufferWidth == w && bufferHeight == h) return true;

        Release();

        // `GetDC(NULL)` couvre l'ecran **virtuel** : les coordonnees peuvent etre
        // negatives sur une configuration multi-ecrans dont le moniteur principal
        // n'est pas le plus a gauche. C'est voulu, l'appelant travaille dans ce
        // meme repere.
        screenDc = GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero) return false;

        memoryDc = CreateCompatibleDC(screenDc);
        if (memoryDc == IntPtr.Zero) { Release(); return false; }

        BITMAPINFO info = new BITMAPINFO();
        info.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        info.bmiHeader.biWidth = w;
        // Hauteur negative = DIB « top-down ». Sans cela GDI rend l'image
        // retournee verticalement et tout le pipeline lirait a l'envers.
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        bitmap = CreateDIBSection(screenDc, ref info, DIB_RGB_COLORS, out pixels, IntPtr.Zero, 0);
        if (bitmap == IntPtr.Zero || pixels == IntPtr.Zero) { Release(); return false; }

        previous = SelectObject(memoryDc, bitmap);
        bufferWidth = w;
        bufferHeight = h;

        int bytes = w * h * 4;
        if (transfer.Length < bytes) transfer = new byte[bytes];
        return true;
    }

    private static void Release()
    {
        if (memoryDc != IntPtr.Zero && previous != IntPtr.Zero) SelectObject(memoryDc, previous);
        if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
        if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
        if (screenDc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screenDc);

        screenDc = memoryDc = bitmap = previous = pixels = IntPtr.Zero;
        bufferWidth = bufferHeight = 0;
    }

    /// <summary>
    /// Repond a `info` : un moniteur par ligne, `x y largeur hauteur primaire`,
    /// en pixels physiques du bureau virtuel.
    /// </summary>
    private static void WriteInfo(Stream output)
    {
        System.Text.StringBuilder builder = new System.Text.StringBuilder();

        MonitorEnumProc callback = delegate (IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(monitor, ref info))
            {
                RECT r = info.rcMonitor;
                int primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0 ? 1 : 0;
                builder.Append(r.left).Append(' ').Append(r.top).Append(' ')
                       .Append(r.right - r.left).Append(' ').Append(r.bottom - r.top).Append(' ')
                       .Append(primary).Append('\n');
            }
            return true;
        };

        try
        {
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        }
        catch
        {
            // Une enumeration impossible se traduit par une reponse vide : cote
            // Node, cela vaut « configuration inconnue » et declenche le repli.
        }

        byte[] payload = System.Text.Encoding.UTF8.GetBytes(builder.ToString());
        WriteLength(output, payload.Length);
        if (payload.Length > 0)
        {
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }
    }

    /// <summary>En-tete de reponse : longueur du payload, int32 little-endian.</summary>
    private static void WriteLength(Stream output, int length)
    {
        byte[] header = BitConverter.GetBytes(length);
        output.Write(header, 0, 4);
        output.Flush();
    }
}
