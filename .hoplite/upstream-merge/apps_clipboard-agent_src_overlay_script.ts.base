/**
 * The overlay window: Windows PowerShell 5.1 hosting a WPF window written in C# (compiled by Add-Type at start), driven by
 * the agent over stdin/stdout (one JSON object per line). It shows the chat, copies text, and hands what the user types to
 * the agent, which sends it to the chat on screen. Double-tap Alt shows it without taking focus; a click into the input
 * field focuses it for typing. A single Alt tap (or Esc) hides it.
 *
 * Kept as a string so the single-file PocketClipboard.exe can write it next to its state and run it. Because this is a
 * JS template literal the code must avoid backticks and the dollar-brace sequence. Add-Type compiles with the C# 5
 * compiler of .NET Framework: no string interpolation, no ?. and no expression-bodied members.
 */
export const OVERLAY_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Web.Extensions, System.Windows.Forms, System.Drawing
$refs = @(
  [System.Windows.Window], [System.Windows.Media.Brush], [System.Windows.Threading.Dispatcher], [System.Xaml.XamlType],
  [System.Web.Script.Serialization.JavaScriptSerializer], [System.Windows.Forms.Clipboard], [System.Drawing.Color]
) | ForEach-Object { $_.Assembly.Location }

Add-Type -ReferencedAssemblies $refs -IgnoreWarnings -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace PocketOverlay
{
    public static class Native
    {
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);
    }

    public sealed class Palette
    {
        public Brush Bg, Bar, Edge, Text, Muted, Faint, Accent, UserBg, UserText, UserChip, BotBg, ChipBg, ChipHover,
            DetailBg, CodeBg, CodeText, InlineBg, InlineText, Link, Quote, Ok, Error, ErrorBg, Wait, Busy, Scrim, Drawer,
            RowActive, RowHover;

        static Brush B(string hex)
        {
            var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            brush.Freeze();
            return brush;
        }

        public static Palette Dark()
        {
            return new Palette
            {
                Bg = B("#0E0E11"), Bar = B("#16161B"), Edge = B("#2A2A33"), Text = B("#ECECF1"), Muted = B("#A0A0AC"), Faint = B("#73737F"),
                Accent = B("#E08A68"), UserBg = B("#26406A"), UserText = B("#F1F5FF"), UserChip = B("#22FFFFFF"), BotBg = B("#1A1A20"),
                ChipBg = B("#1C1C23"), ChipHover = B("#2A2A33"), DetailBg = B("#131318"), CodeBg = B("#101014"), CodeText = B("#E3E6EE"),
                InlineBg = B("#2A2A33"), InlineText = B("#F2B999"), Link = B("#8AB0FF"), Quote = B("#B8B8C2"), Ok = B("#4CC38A"),
                Error = B("#FF7A85"), ErrorBg = B("#2B1519"), Wait = B("#F0B95A"), Busy = B("#8AB0FF"), Scrim = B("#99000000"),
                Drawer = B("#141419"), RowActive = B("#262630"), RowHover = B("#1D1D24"),
            };
        }

        public static Palette Light()
        {
            return new Palette
            {
                Bg = B("#FFFFFF"), Bar = B("#F5F5F7"), Edge = B("#DEDEE5"), Text = B("#1B1B20"), Muted = B("#5E5E69"), Faint = B("#8C8C97"),
                Accent = B("#B9532F"), UserBg = B("#DCE8FF"), UserText = B("#0E1A33"), UserChip = B("#14000000"), BotBg = B("#F3F3F6"),
                ChipBg = B("#F0F0F4"), ChipHover = B("#E4E4EB"), DetailBg = B("#FAFAFC"), CodeBg = B("#F6F6F9"), CodeText = B("#1E1E26"),
                InlineBg = B("#E9E9EF"), InlineText = B("#A2412A"), Link = B("#2453B8"), Quote = B("#55555F"), Ok = B("#17864F"),
                Error = B("#C42536"), ErrorBg = B("#FDECEE"), Wait = B("#9A6100"), Busy = B("#2453B8"), Scrim = B("#55000000"),
                Drawer = B("#FFFFFF"), RowActive = B("#E9E9F1"), RowHover = B("#F3F3F7"),
            };
        }
    }

    public sealed class Overlay
    {
        const double WinWidth = 460, CompactHeight = 640, Gap = 12, DrawerWidth = 300;
        // Long chats draw their last messages first; older ones come on demand, so opening a chat stays quick.
        const int RenderLimit = 150;
        const string BareXaml =
            "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' TargetType='ButtonBase'>" +
            "<Border Background='{TemplateBinding Background}' Padding='{TemplateBinding Padding}'>" +
            "<ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}' VerticalAlignment='{TemplateBinding VerticalContentAlignment}' RecognizesAccessKey='False'/>" +
            "</Border></ControlTemplate>";
        const string ScrollBarXaml =
            "<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ScrollBar'>" +
            "<Setter Property='Width' Value='10'/><Setter Property='MinWidth' Value='10'/>" +
            "<Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ScrollBar'>" +
            "<Grid Background='Transparent'><Track x:Name='PART_Track' IsDirectionReversed='True'><Track.Thumb>" +
            "<Thumb MinHeight='24'><Thumb.Template><ControlTemplate TargetType='Thumb'><Border CornerRadius='3' Margin='3,2' Background='#66888892'/></ControlTemplate></Thumb.Template></Thumb>" +
            "</Track.Thumb></Track></Grid></ControlTemplate></Setter.Value></Setter></Style>";

        static readonly FontFamily UiFont = new FontFamily("Segoe UI");
        static readonly FontFamily MonoFont = new FontFamily("Cascadia Mono, Consolas, Courier New");
        static readonly FontFamily IconFont = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets");
        static readonly FontFamily SymbolFont = new FontFamily("Segoe UI Symbol");
        static readonly object OutLock = new object();
        static readonly object[] None = new object[0];
        static readonly int[] ComboKeys = MakeComboKeys();

        sealed class Row
        {
            public string Id, Role;
            public IDictionary<string, object> Data;
            public FrameworkElement View;
            public Border Bubble;
        }

        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        readonly List<Row> rows = new List<Row>();
        // Opened action rows ("a:<id>") and groups ("g:<id>"); kept while the same chat stays on screen.
        readonly Dictionary<string, bool> open = new Dictionary<string, bool>();
        readonly Dictionary<string, bool> dirty = new Dictionary<string, bool>();
        int drainQueued;
        volatile bool inputClosed;
        bool fullRender, chatsDirty;

        Palette P = Palette.Dark();
        string themeName = "dark";
        Window win;
        ControlTemplate bare;
        ScrollViewer scroll;
        StackPanel chatList, chatsPanel;
        Button earlier;
        TextBlock titleBlock, statusBlock, placeholder, flashBlock, chatsCount, tallIcon;
        DockPanel statusLine;
        Ellipse statusDot;
        Border drawer, scrim;
        TranslateTransform drawerShift;
        DispatcherTimer flashTimer;
        TextBox composer;
        TextBlock composerHint, sendError, sendIcon;
        Border composerBox, sendBox;
        Button sendButton;
        // What is typed survives a theme switch, which rebuilds the window.
        string draft = "";
        bool sending;

        IList chats = None;
        string chatId = "", titleText = "Pocket", statusText = "", statusTone = "idle";
        string selectedId;
        int renderFrom;
        bool loading, autoScroll = true, tall, drawerOpen;
        bool altDown, altCombo;
        int altSince, lastTap;

        public static void Run()
        {
            new Overlay().Start();
        }

        static int[] MakeComboKeys()
        {
            var keys = new List<int> { 0x09, 0x0D, 0x1B, 0x20, 0x10, 0x11, 0x5B, 0x73 };
            for (int k = 0x30; k <= 0x5A; k++) keys.Add(k);
            return keys.ToArray();
        }

        void Start()
        {
            json.MaxJsonLength = int.MaxValue;
            json.RecursionLimit = 512;
            try { Native.SetProcessDPIAware(); } catch (Exception) { }
            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            app.DispatcherUnhandledException += OnCrash;
            bare = (ControlTemplate)XamlReader.Parse(BareXaml);
            win = new Window();
            win.Title = "Pocket";
            win.WindowStyle = WindowStyle.None;
            win.ResizeMode = ResizeMode.NoResize;
            win.ShowInTaskbar = false;
            // Showing never steals focus from the editor; WS_EX_TOOLWINDOW (StyleHwnd) keeps it out of Alt+Tab.
            win.ShowActivated = false;
            win.Topmost = true;
            win.WindowStartupLocation = WindowStartupLocation.Manual;
            win.FontFamily = UiFont;
            win.FontSize = 14;
            win.UseLayoutRounding = true;
            win.SnapsToDevicePixels = true;
            TextOptions.SetTextFormattingMode(win, TextFormattingMode.Display);
            win.Resources.Add(typeof(ScrollBar), XamlReader.Parse(ScrollBarXaml));
            win.SourceInitialized += delegate { StyleHwnd(); };
            win.PreviewKeyDown += OnKey;
            Place();
            Build();
            StartInput(app.Dispatcher);
            StartKeys();
            Emit("ready");
            app.Run();
        }

        void OnCrash(object sender, DispatcherUnhandledExceptionEventArgs e)
        {
            Emit("error", "message", e.Exception.Message);
            e.Handled = true;
        }

        void StyleHwnd()
        {
            const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
            IntPtr hwnd = new WindowInteropHelper(win).Handle;
            Native.SetWindowLong(hwnd, GWL_EXSTYLE, (Native.GetWindowLong(hwnd, GWL_EXSTYLE) | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
            try
            {
                int round = 2; // DWMWCP_ROUND: rounded corners on Windows 11, ignored before it
                Native.DwmSetWindowAttribute(hwnd, 33, ref round, 4);
            }
            catch (Exception) { }
        }

        void Place()
        {
            Rect area = SystemParameters.WorkArea;
            double h = tall ? area.Height - 2 * Gap : Math.Min(CompactHeight, area.Height - 2 * Gap);
            win.Width = WinWidth;
            win.Height = h;
            win.Left = area.Right - WinWidth - Gap;
            win.Top = area.Bottom - h - Gap;
        }

        // ---------------------------------------------------------------- chrome

        void Build()
        {
            if (composer != null) draft = composer.Text;
            win.Background = P.Bg;
            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Put(root, BuildHeader(), 0, 0);
            Put(root, BuildBody(), 0, 1);
            Put(root, BuildFooter(), 0, 2);
            win.Content = new Border { BorderBrush = P.Edge, BorderThickness = new Thickness(1), Child = root };
            drawerOpen = false;
            ApplyStatus();
            RenderAll();
            RenderChats();
        }

        FrameworkElement BuildHeader()
        {
            var g = new Grid { Height = 52, Background = P.Bar };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var chatsButton = IconButton("\uE700", "Чаты", "chats", ToggleDrawer, 15);
            chatsButton.Margin = new Thickness(6, 0, 2, 0);
            Put(g, chatsButton, 0, 0);

            var titles = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(4, 0, 8, 0) };
            titleBlock = OneLine(titleText, P.Text, 14);
            titleBlock.FontWeight = FontWeights.SemiBold;
            statusLine = new DockPanel { Margin = new Thickness(0, 2, 0, 0) };
            statusDot = new Ellipse { Width = 7, Height = 7, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 6, 0) };
            DockPanel.SetDock(statusDot, Dock.Left);
            statusBlock = OneLine("", P.Muted, 12);
            statusLine.Children.Add(statusDot);
            statusLine.Children.Add(statusBlock);
            titles.Children.Add(titleBlock);
            titles.Children.Add(statusLine);
            Put(g, titles, 1, 0);

            Put(g, IconButton("\uE706", "Светлая или тёмная тема", "theme", ToggleTheme, 14), 2, 0);
            var tallButton = IconButton(tall ? "\uE73F" : "\uE740", "Высокое окно", "tall", ToggleTall, 13);
            tallIcon = (TextBlock)((Border)tallButton.Content).Child;
            Put(g, tallButton, 3, 0);
            var hide = IconButton("\uE8BB", "Скрыть (Alt или Esc)", "hide", HideOverlay, 11);
            hide.Margin = new Thickness(0, 0, 6, 0);
            Put(g, hide, 4, 0);
            // The header is the handle for moving the window; buttons on it handle their own clicks.
            g.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                try { win.DragMove(); } catch (InvalidOperationException) { }
            };
            return new Border { BorderBrush = P.Edge, BorderThickness = new Thickness(0, 0, 0, 1), Child = g };
        }

        FrameworkElement BuildBody()
        {
            var body = new Grid { ClipToBounds = true };
            var content = new StackPanel { Margin = new Thickness(14, 4, 12, 16) };
            earlier = TextButton("\uE70E", "Показать более ранние сообщения", "earlier", ShowEarlier, 12.5);
            earlier.HorizontalAlignment = HorizontalAlignment.Center;
            earlier.Margin = new Thickness(0, 8, 0, 0);
            chatList = new StackPanel();
            content.Children.Add(earlier);
            content.Children.Add(chatList);
            scroll = new ScrollViewer
            {
                Content = content,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Focusable = false,
                PanningMode = PanningMode.VerticalOnly,
            };
            AutomationProperties.SetAutomationId(scroll, "transcript");
            scroll.ScrollChanged += OnScroll;
            placeholder = new TextBlock
            {
                Foreground = P.Faint, FontSize = 13, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(40),
                IsHitTestVisible = false,
            };
            scrim = new Border { Background = P.Scrim, Visibility = Visibility.Collapsed, Opacity = 0 };
            scrim.MouseLeftButtonDown += delegate { CloseDrawer(); };
            drawerShift = new TranslateTransform(-DrawerWidth, 0);
            drawer = new Border
            {
                Width = DrawerWidth, HorizontalAlignment = HorizontalAlignment.Left, Background = P.Drawer, BorderBrush = P.Edge,
                BorderThickness = new Thickness(0, 0, 1, 0), Visibility = Visibility.Collapsed, RenderTransform = drawerShift, Child = BuildDrawer(),
            };
            body.Children.Add(scroll);
            body.Children.Add(placeholder);
            body.Children.Add(scrim);
            body.Children.Add(drawer);
            return body;
        }

        FrameworkElement BuildDrawer()
        {
            var dock = new DockPanel();
            var head = new DockPanel { Margin = new Thickness(16, 12, 12, 8) };
            var name = OneLine("Чаты", P.Text, 15);
            name.FontWeight = FontWeights.SemiBold;
            DockPanel.SetDock(name, Dock.Left);
            chatsCount = OneLine("", P.Faint, 12.5);
            chatsCount.Margin = new Thickness(8, 2, 0, 0);
            chatsCount.VerticalAlignment = VerticalAlignment.Center;
            head.Children.Add(name);
            head.Children.Add(chatsCount);
            DockPanel.SetDock(head, Dock.Top);
            var hint = new TextBlock
            {
                Text = "Окно само переходит в чат, в котором вы пишете с телефона.",
                Foreground = P.Faint, FontSize = 11.5, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(16, 8, 16, 12),
            };
            DockPanel.SetDock(hint, Dock.Bottom);
            chatsPanel = new StackPanel { Margin = new Thickness(0, 0, 0, 6) };
            var list = new ScrollViewer
            {
                Content = chatsPanel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false,
            };
            dock.Children.Add(head);
            dock.Children.Add(hint);
            dock.Children.Add(list);
            return dock;
        }

        FrameworkElement BuildFooter()
        {
            var tools = new Grid { Height = 38 };
            tools.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            tools.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            tools.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            flashBlock = OneLine("", P.Muted, 12);
            flashBlock.VerticalAlignment = VerticalAlignment.Center;
            flashBlock.Margin = new Thickness(14, 0, 8, 0);
            Put(tools, flashBlock, 0, 0);
            var code = TextButton("\uE943", "Копировать код", "copy-code", CopyCode, 12.5);
            code.Margin = new Thickness(0, 0, 2, 0);
            Put(tools, code, 1, 0);
            var reply = TextButton("\uE8C8", "Копировать ответ", "copy-reply", CopyReply, 12.5);
            reply.Margin = new Thickness(0, 0, 8, 0);
            Put(tools, reply, 2, 0);
            sendError = new TextBlock
            {
                Foreground = P.Error, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(16, 0, 16, 6),
                Visibility = Visibility.Collapsed,
            };
            AutomationProperties.SetAutomationId(sendError, "send-error");
            var panel = new StackPanel { Background = P.Bar };
            panel.Children.Add(tools);
            panel.Children.Add(sendError);
            panel.Children.Add(BuildComposer());
            return new Border { BorderBrush = P.Edge, BorderThickness = new Thickness(0, 1, 0, 0), Child = panel };
        }

        // ---------------------------------------------------------------- writing to the chat

        FrameworkElement BuildComposer()
        {
            var g = new Grid { Margin = new Thickness(10, 0, 10, 10) };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            composer = new TextBox
            {
                AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 22, MaxHeight = 132, Padding = new Thickness(0),
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                BorderThickness = new Thickness(0), Background = Brushes.Transparent, Foreground = P.Text, CaretBrush = P.Text,
                SelectionBrush = P.Accent, FontSize = 14, VerticalContentAlignment = VerticalAlignment.Center, Text = draft,
            };
            composer.CaretIndex = draft.Length;
            AutomationProperties.SetAutomationId(composer, "composer");
            AutomationProperties.SetName(composer, "Сообщение для Claude");
            composer.PreviewKeyDown += OnComposerKey;
            composer.TextChanged += delegate
            {
                if (!sending) ClearSendError();
                UpdateComposer();
            };
            composer.GotKeyboardFocus += delegate { composerBox.BorderBrush = P.Accent; };
            composer.LostKeyboardFocus += delegate { composerBox.BorderBrush = P.Edge; };
            composerHint = new TextBlock
            {
                Foreground = P.Faint, FontSize = 14, Margin = new Thickness(2, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
                IsHitTestVisible = false, TextTrimming = TextTrimming.CharacterEllipsis,
            };
            var field = new Grid();
            field.Children.Add(composerHint);
            field.Children.Add(composer);
            composerBox = new Border
            {
                Background = P.ChipBg, BorderBrush = P.Edge, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(19),
                Padding = new Thickness(14, 7, 10, 7), MinHeight = 38, Cursor = Cursors.IBeam, Child = field,
            };
            // A click on the padding around the text focuses it too.
            composerBox.MouseLeftButtonDown += delegate { composer.Focus(); };
            Put(g, composerBox, 0, 0);
            sendIcon = Icon("\uE724", P.Faint, 14);
            sendIcon.HorizontalAlignment = HorizontalAlignment.Center;
            sendIcon.Margin = new Thickness(2, 0, 0, 0);
            sendBox = new Border { Width = 38, Height = 38, CornerRadius = new CornerRadius(19), Child = sendIcon };
            sendButton = MakeButton(sendBox, "send", "Отправить", Send);
            sendButton.ToolTip = "Отправить: Enter. Новая строка: Shift+Enter";
            sendButton.Margin = new Thickness(8, 0, 0, 0);
            sendButton.VerticalAlignment = VerticalAlignment.Bottom;
            Put(g, sendButton, 1, 0);
            return g;
        }

        bool CanWrite()
        {
            return chatId.Length > 0 && statusTone != "offline";
        }

        void UpdateComposer()
        {
            if (composer == null) return;
            bool can = CanWrite();
            composer.IsReadOnly = sending;
            composerBox.Opacity = sending ? 0.6 : 1;
            composerHint.Text = chatId.Length == 0 ? "Чата нет: начните его на телефоне" : statusTone == "offline" ? "Mac не в сети" : "Написать Claude…";
            composerHint.Visibility = composer.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            bool ready = can && !sending && composer.Text.Trim().Length > 0;
            sendButton.IsEnabled = ready;
            sendButton.Cursor = ready ? Cursors.Hand : Cursors.Arrow;
            sendBox.Background = ready ? P.Accent : P.ChipBg;
            sendIcon.Foreground = ready ? Brushes.White : P.Faint;
            sendIcon.Text = sending ? "\uE712" : "\uE724";
        }

        void OnComposerKey(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Enter || (Keyboard.Modifiers & ModifierKeys.Shift) != 0) return;
            e.Handled = true;
            Send();
        }

        void Send()
        {
            if (composer == null || sending) return;
            string text = composer.Text.Trim();
            if (text.Length == 0) return;
            if (!CanWrite())
            {
                ShowSendError(chatId.Length == 0 ? "Чата нет: начните его на телефоне." : "Mac не в сети, отправить нельзя.");
                return;
            }
            sending = true;
            ClearSendError();
            UpdateComposer();
            Emit("send", "chatId", chatId, "text", text);
        }

        // The message is in the chat: its bubble arrives with the chat's events, the field empties.
        void Sent(string text)
        {
            sending = false;
            if (composer.Text.Trim() == text) composer.Text = "";
            draft = "";
            autoScroll = true;
            win.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(ScrollToEnd));
            UpdateComposer();
        }

        void Unsent(string text, string error)
        {
            sending = false;
            if (composer.Text.Length == 0 && text.Length > 0)
            {
                composer.Text = text;
                composer.CaretIndex = text.Length;
            }
            ShowSendError(error);
            UpdateComposer();
        }

        void ShowSendError(string text)
        {
            sendError.Text = text;
            sendError.Visibility = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        void ClearSendError()
        {
            if (sendError != null && sendError.Visibility == Visibility.Visible) ShowSendError("");
        }

        Button MakeButton(object content, string id, string name, Action click)
        {
            var b = new Button
            {
                Template = bare, OverridesDefaultStyle = true, Content = content, Focusable = false, Cursor = Cursors.Hand,
                Background = Brushes.Transparent, Padding = new Thickness(0), HorizontalContentAlignment = HorizontalAlignment.Stretch,
                VerticalContentAlignment = VerticalAlignment.Center,
            };
            AutomationProperties.SetAutomationId(b, id);
            AutomationProperties.SetName(b, name);
            b.Click += delegate { click(); };
            return b;
        }

        static void Hover(UIElement trigger, Border box, Brush normal, Brush hover)
        {
            trigger.MouseEnter += delegate { box.Background = hover; };
            trigger.MouseLeave += delegate { box.Background = normal; };
        }

        Button IconButton(string glyph, string tip, string id, Action click, double size)
        {
            var icon = Icon(glyph, P.Muted, size);
            icon.HorizontalAlignment = HorizontalAlignment.Center;
            var box = new Border { Width = 34, Height = 34, CornerRadius = new CornerRadius(8), Background = Brushes.Transparent, Child = icon };
            var b = MakeButton(box, id, tip, click);
            b.ToolTip = tip;
            b.VerticalAlignment = VerticalAlignment.Center;
            Hover(b, box, Brushes.Transparent, P.ChipHover);
            return b;
        }

        Button TextButton(string glyph, string text, string id, Action click, double size)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            var icon = Icon(glyph, P.Muted, size - 0.5);
            icon.Margin = new Thickness(0, 1, 6, 0);
            row.Children.Add(icon);
            row.Children.Add(new TextBlock { Text = text, Foreground = P.Text, FontSize = size, VerticalAlignment = VerticalAlignment.Center });
            var box = new Border { CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 5, 10, 6), Background = Brushes.Transparent, Child = row };
            var b = MakeButton(box, id, text, click);
            b.VerticalAlignment = VerticalAlignment.Center;
            Hover(b, box, Brushes.Transparent, P.ChipHover);
            return b;
        }

        void ApplyStatus()
        {
            titleBlock.Text = titleText;
            statusBlock.Text = statusText;
            statusBlock.Foreground = statusTone == "idle" || statusTone.Length == 0 ? P.Muted : ToneBrush(statusTone);
            statusDot.Fill = ToneBrush(statusTone);
            statusLine.Visibility = statusText.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            UpdateComposer();
        }

        Brush ToneBrush(string tone)
        {
            switch (tone)
            {
                case "busy": return P.Busy;
                case "wait": return P.Wait;
                case "offline": return P.Error;
                default: return P.Ok;
            }
        }

        // ---------------------------------------------------------------- input from the agent

        void StartInput(Dispatcher dispatcher)
        {
            // Console.In cannot be read on the UI thread without blocking it; lines are queued and drained in batches.
            var reader = new Thread(delegate()
            {
                try
                {
                    using (var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                    {
                        string line;
                        while ((line = r.ReadLine()) != null)
                        {
                            inbox.Enqueue(line);
                            Wake(dispatcher);
                        }
                    }
                }
                catch (Exception) { }
                inputClosed = true;
                Wake(dispatcher);
            });
            reader.IsBackground = true;
            reader.Start();
        }

        void Wake(Dispatcher dispatcher)
        {
            if (Interlocked.Exchange(ref drainQueued, 1) == 0) dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Drain));
        }

        // A burst of streamed words redraws the reply once, not once per word.
        void Drain()
        {
            Interlocked.Exchange(ref drainQueued, 0);
            string line;
            while (inbox.TryDequeue(out line))
            {
                try { HandleOp(json.DeserializeObject(line) as IDictionary<string, object>); }
                catch (Exception e) { Emit("error", "message", e.Message); }
            }
            try { Flush(); }
            catch (Exception e) { Emit("error", "message", e.Message); }
            if (inputClosed && inbox.IsEmpty) Application.Current.Shutdown();
        }

        void HandleOp(IDictionary<string, object> op)
        {
            if (op == null) return;
            switch (S(op, "op"))
            {
                case "reset": Reset(op); break;
                case "upsert": Upsert(D(op, "message")); break;
                case "title": titleText = S(op, "title"); ApplyStatus(); break;
                case "status": SetStatus(D(op, "status")); break;
                case "chats": chats = L(op, "chats") ?? None; chatsDirty = true; break;
                case "theme": SetTheme(S(op, "theme")); break;
                case "sent": Sent(S(op, "text")); break;
                case "unsent": Unsent(S(op, "text"), S(op, "error")); break;
                case "notice": ShowSendError(S(op, "text")); break;
                case "quit": Application.Current.Shutdown(); break;
            }
        }

        void Reset(IDictionary<string, object> op)
        {
            string theme = S(op, "theme");
            if (theme.Length > 0) SetTheme(theme);
            string id = S(op, "chatId");
            if (id != chatId)
            {
                open.Clear();
                selectedId = null;
                autoScroll = true;
                ClearSendError();
            }
            chatId = id;
            titleText = S(op, "title");
            SetStatus(D(op, "status"));
            IList list = L(op, "chats");
            if (list != null) { chats = list; chatsDirty = true; }
            loading = B(op, "loading");
            rows.Clear();
            foreach (object o in L(op, "messages") ?? None)
            {
                var m = o as IDictionary<string, object>;
                if (m != null) rows.Add(new Row { Id = S(m, "id"), Role = S(m, "role"), Data = m });
            }
            renderFrom = Math.Max(0, rows.Count - RenderLimit);
            fullRender = true;
            UpdateComposer();
        }

        void Upsert(IDictionary<string, object> m)
        {
            if (m == null) return;
            string id = S(m, "id");
            int i = IndexOf(id);
            if (i < 0) rows.Add(new Row { Id = id, Role = S(m, "role"), Data = m });
            else
            {
                rows[i].Data = m;
                rows[i].Role = S(m, "role");
            }
            dirty[id] = true;
        }

        void SetStatus(IDictionary<string, object> s)
        {
            if (s == null) return;
            statusText = S(s, "text");
            statusTone = S(s, "tone");
            ApplyStatus();
        }

        void SetTheme(string name)
        {
            if ((name != "dark" && name != "light") || name == themeName) return;
            themeName = name;
            P = name == "light" ? Palette.Light() : Palette.Dark();
            Build();
        }

        void Flush()
        {
            if (fullRender)
            {
                fullRender = false;
                dirty.Clear();
                RenderAll();
            }
            else if (dirty.Count > 0)
            {
                var ids = new List<string>(dirty.Keys);
                dirty.Clear();
                foreach (string id in ids) RenderRow(id);
            }
            if (chatsDirty)
            {
                chatsDirty = false;
                RenderChats();
            }
        }

        int IndexOf(string id)
        {
            for (int i = rows.Count - 1; i >= 0; i--) if (rows[i].Id == id) return i;
            return -1;
        }

        // ---------------------------------------------------------------- transcript

        void RenderAll()
        {
            chatList.Children.Clear();
            for (int i = 0; i < rows.Count; i++)
            {
                rows[i].View = null;
                rows[i].Bubble = null;
            }
            for (int i = renderFrom; i < rows.Count; i++)
            {
                rows[i].View = BuildRow(rows[i]);
                chatList.Children.Add(rows[i].View);
            }
            earlier.Visibility = renderFrom > 0 ? Visibility.Visible : Visibility.Collapsed;
            UpdatePlaceholder();
            if (autoScroll) win.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(ScrollToEnd));
        }

        void RenderRow(string id)
        {
            int i = IndexOf(id);
            if (i < renderFrom) return;
            Row row = rows[i];
            int slot = i - renderFrom;
            FrameworkElement view = BuildRow(row);
            if (row.View != null && slot < chatList.Children.Count && chatList.Children[slot] == row.View)
            {
                // A panel slot cannot be overwritten while it holds a child: take the old view out first.
                chatList.Children.RemoveAt(slot);
                chatList.Children.Insert(slot, view);
            }
            else if (row.View == null && slot == chatList.Children.Count) chatList.Children.Add(view);
            else
            {
                RenderAll();
                return;
            }
            row.View = view;
            UpdatePlaceholder();
        }

        void UpdatePlaceholder()
        {
            if (rows.Count > 0)
            {
                placeholder.Visibility = Visibility.Collapsed;
                return;
            }
            placeholder.Text = loading ? "Загружаю переписку…" : chatId.Length == 0 ? "Здесь появится переписка с Claude." : "В этом чате пока нет сообщений.";
            placeholder.Visibility = Visibility.Visible;
        }

        void ShowEarlier()
        {
            if (renderFrom == 0) return;
            double extent = scroll.ExtentHeight, offset = scroll.VerticalOffset;
            autoScroll = false;
            renderFrom = Math.Max(0, renderFrom - RenderLimit);
            RenderAll();
            scroll.UpdateLayout();
            scroll.ScrollToVerticalOffset(offset + scroll.ExtentHeight - extent);
        }

        void OnScroll(object sender, ScrollChangedEventArgs e)
        {
            // Follow new text only while the reader is at the bottom; someone reading above keeps their place.
            if (e.ExtentHeightChange == 0 && e.ViewportHeightChange == 0) autoScroll = scroll.VerticalOffset >= scroll.ScrollableHeight - 8;
            else if (autoScroll) scroll.ScrollToEnd();
        }

        void ScrollToEnd()
        {
            scroll.ScrollToEnd();
        }

        FrameworkElement BuildRow(Row r)
        {
            r.Bubble = null;
            try
            {
                switch (r.Role)
                {
                    case "user": return BuildUser(r);
                    case "assistant": return BuildAssistant(r);
                    case "actions": return BuildActions(r);
                    case "error": return BuildError(r);
                }
            }
            catch (Exception e)
            {
                Emit("error", "message", "render " + r.Role + ": " + e.Message);
            }
            return new Border();
        }

        FrameworkElement BuildUser(Row r)
        {
            var m = r.Data;
            var col = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(48, 16, 0, 0) };
            var who = Caption(B(m, "voice") ? "Вы · голосом" : "Вы", P.Muted);
            who.HorizontalAlignment = HorizontalAlignment.Right;
            who.Margin = new Thickness(0, 0, 6, 4);
            col.Children.Add(who);
            var body = new StackPanel();
            AddBlocks(body, L(m, "blocks"), P.UserText);
            var files = D(m, "attachments");
            if (files != null) body.Children.Add(ActionView(files, r.Id, P.UserChip, body.Children.Count > 0));
            col.Children.Add(new Border
            {
                Background = P.UserBg, CornerRadius = new CornerRadius(16, 16, 4, 16), Padding = new Thickness(13, 9, 13, 10),
                HorizontalAlignment = HorizontalAlignment.Right, Child = body,
            });
            return col;
        }

        FrameworkElement BuildAssistant(Row r)
        {
            var m = r.Data;
            bool first = B(m, "first");
            var col = new StackPanel { Margin = new Thickness(0, first ? 16 : 8, 20, 0) };
            if (first)
            {
                var who = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 0, 0, 4) };
                who.Children.Add(new TextBlock { Text = "\u273B", FontFamily = SymbolFont, Foreground = P.Accent, FontSize = 13, Margin = new Thickness(0, 0, 5, 0), VerticalAlignment = VerticalAlignment.Center });
                who.Children.Add(Caption("Claude", P.Accent));
                col.Children.Add(who);
            }
            var body = new StackPanel();
            AddBlocks(body, L(m, "blocks"), P.Text);
            if (B(m, "streaming"))
            {
                var typing = Caption("пишет…", P.Faint);
                typing.FontWeight = FontWeights.Normal;
                if (body.Children.Count > 0) typing.Margin = new Thickness(0, 6, 0, 0);
                body.Children.Add(typing);
            }
            var bubble = new Border
            {
                Background = P.BotBg, CornerRadius = new CornerRadius(4, 16, 16, 16), Padding = new Thickness(13, 10, 13, 11),
                BorderThickness = new Thickness(1), BorderBrush = r.Id == selectedId ? P.Accent : Brushes.Transparent,
                HorizontalAlignment = HorizontalAlignment.Left, Child = body,
            };
            string id = r.Id;
            // A click picks the reply "Копировать ответ" copies; without one it takes the last reply.
            bubble.MouseLeftButtonUp += delegate { Select(id); };
            r.Bubble = bubble;
            col.Children.Add(bubble);
            return col;
        }

        FrameworkElement BuildError(Row r)
        {
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var icon = Icon("\uE7BA", P.Error, 13);
            icon.VerticalAlignment = VerticalAlignment.Top;
            icon.Margin = new Thickness(0, 2, 8, 0);
            Put(g, icon, 0, 0);
            Put(g, new TextBlock
            {
                Text = S(r.Data, "text"), Foreground = P.Error, FontSize = 13, TextWrapping = TextWrapping.Wrap, LineHeight = 19,
                LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            }, 1, 0);
            return new Border
            {
                Background = P.ErrorBg, CornerRadius = new CornerRadius(10), Padding = new Thickness(11, 8, 12, 9), Margin = new Thickness(0, 10, 20, 0),
                HorizontalAlignment = HorizontalAlignment.Left, Child = g,
            };
        }

        FrameworkElement BuildActions(Row r)
        {
            var m = r.Data;
            var col = new StackPanel { Margin = new Thickness(4, 8, 20, 0) };
            IList actions = L(m, "actions") ?? None;
            var group = D(m, "group");
            string rowId = r.Id;
            if (group == null)
            {
                foreach (object o in actions)
                {
                    var a = o as IDictionary<string, object>;
                    if (a != null) col.Children.Add(ActionView(a, rowId, P.ChipBg, false));
                }
                return col;
            }
            string key = "g:" + rowId;
            bool isOpen = open.ContainsKey(key);
            col.Children.Add(Chip("\uE8FD", S(group, "label"), S(group, "summary"), S(m, "state"), isOpen, "group:" + rowId, P.ChipBg, delegate { Toggle(key, rowId); }));
            if (isOpen)
            {
                var inner = new StackPanel();
                foreach (object o in actions)
                {
                    var a = o as IDictionary<string, object>;
                    if (a != null) inner.Children.Add(ActionView(a, rowId, P.ChipBg, false));
                }
                col.Children.Add(new Border
                {
                    BorderBrush = P.Edge, BorderThickness = new Thickness(2, 0, 0, 0), Margin = new Thickness(10, 4, 0, 0),
                    Padding = new Thickness(10, 0, 0, 0), Child = inner,
                });
            }
            return col;
        }

        FrameworkElement ActionView(IDictionary<string, object> a, string rowId, Brush chipBg, bool spaced)
        {
            string id = S(a, "id");
            string key = "a:" + id;
            bool isOpen = open.ContainsKey(key);
            var col = new StackPanel { Margin = new Thickness(0, spaced ? 8 : 2, 0, 2) };
            col.Children.Add(Chip(KindGlyph(S(a, "kind")), S(a, "label"), S(a, "short"), S(a, "state"), isOpen, "act:" + id, chipBg, delegate { Toggle(key, rowId); }));
            if (isOpen) col.Children.Add(Details(L(a, "parts")));
            return col;
        }

        // One line per action: icon, kind, the first words of its target, state, chevron. A click opens everything it did.
        Button Chip(string glyph, string label, string detail, string state, bool isOpen, string id, Brush bg, Action click)
        {
            var g = new Grid();
            for (int i = 0; i < 5; i++) g.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 2 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
            var icon = Icon(glyph, P.Muted, 12);
            icon.Margin = new Thickness(0, 0, 7, 0);
            Put(g, icon, 0, 0);
            var name = OneLine(label, P.Text, 12.5);
            name.FontWeight = FontWeights.SemiBold;
            Put(g, name, 1, 0);
            if (detail.Length > 0)
            {
                var d = OneLine(detail, P.Muted, 12.5);
                d.Margin = new Thickness(6, 0, 0, 0);
                Put(g, d, 2, 0);
            }
            var mark = StateMark(state);
            mark.Margin = new Thickness(8, 0, 0, 0);
            Put(g, mark, 3, 0);
            var chevron = Icon(isOpen ? "\uE70D" : "\uE76C", P.Faint, 9);
            chevron.Margin = new Thickness(8, 1, 0, 0);
            Put(g, chevron, 4, 0);
            var box = new Border { Background = bg, CornerRadius = new CornerRadius(8), Padding = new Thickness(9, 5, 9, 5), Child = g };
            var b = MakeButton(box, id, label + " " + detail, click);
            b.HorizontalAlignment = HorizontalAlignment.Left;
            Hover(b, box, bg, P.ChipHover);
            return b;
        }

        FrameworkElement StateMark(string state)
        {
            switch (state)
            {
                case "running": return Icon("\uE712", P.Busy, 12);
                case "waiting":
                {
                    var row = new StackPanel { Orientation = Orientation.Horizontal };
                    row.Children.Add(Icon("\uE7BA", P.Wait, 11));
                    var t = OneLine("ждёт разрешения", P.Wait, 11.5);
                    t.Margin = new Thickness(4, 0, 0, 0);
                    row.Children.Add(t);
                    return row;
                }
                case "error": return Icon("\uE711", P.Error, 11);
                case "stopped": return Icon("\uE71A", P.Faint, 10);
                default: return Icon("\uE73E", P.Ok, 11);
            }
        }

        FrameworkElement Details(IList parts)
        {
            var col = new StackPanel();
            foreach (object o in parts ?? None)
            {
                var p = o as IDictionary<string, object>;
                if (p == null) continue;
                var label = OneLine(S(p, "label"), P.Faint, 11);
                label.FontWeight = FontWeights.SemiBold;
                label.Margin = new Thickness(0, col.Children.Count == 0 ? 0 : 9, 0, 3);
                col.Children.Add(label);
                string text = S(p, "text");
                var body = new TextBlock
                {
                    Text = text, FontFamily = MonoFont, FontSize = 12, Foreground = P.CodeText, TextWrapping = TextWrapping.Wrap, LineHeight = 17,
                    LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
                };
                body.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
                {
                    if (e.ClickCount != 2) return;
                    Copy(text, "action");
                    e.Handled = true;
                };
                col.Children.Add(body);
            }
            if (col.Children.Count == 0) col.Children.Add(OneLine("Подробностей нет", P.Faint, 12));
            return new Border
            {
                Background = P.DetailBg, BorderBrush = P.Edge, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
                Padding = new Thickness(11, 8, 11, 10), Margin = new Thickness(14, 3, 0, 5), Child = col,
            };
        }

        static string KindGlyph(string kind)
        {
            switch (kind)
            {
                case "command": return "\uE756";
                case "read": return "\uE8A5";
                case "edit": return "\uE70F";
                case "write": return "\uE74E";
                case "search": return "\uE721";
                case "folder": return "\uE8B7";
                case "web": return "\uE774";
                case "screen": return "\uE722";
                case "clipboard": return "\uE77F";
                case "agent": return "\uE99A";
                case "todo": return "\uE9D5";
                case "git": return "\uE8AB";
                case "plan": return "\uE8FD";
                case "skill": return "\uE945";
                case "attach": return "\uE723";
                default: return "\uE90F";
            }
        }

        void Toggle(string key, string rowId)
        {
            if (open.ContainsKey(key)) open.Remove(key);
            else open[key] = true;
            // The reader is looking at this row: new text below must not scroll it away.
            autoScroll = false;
            RenderRow(rowId);
        }

        void Select(string id)
        {
            if (selectedId == id) return;
            string previous = selectedId;
            selectedId = id;
            foreach (string rowId in new[] { previous, id })
            {
                if (rowId == null) continue;
                int i = IndexOf(rowId);
                if (i >= 0 && rows[i].Bubble != null) rows[i].Bubble.BorderBrush = rowId == selectedId ? P.Accent : Brushes.Transparent;
            }
        }

        // ---------------------------------------------------------------- markdown blocks

        void AddBlocks(Panel host, IList blocks, Brush fg)
        {
            if (blocks == null) return;
            foreach (object o in blocks)
            {
                var b = o as IDictionary<string, object>;
                if (b == null) continue;
                FrameworkElement view = BlockView(b, fg);
                if (host.Children.Count > 0) view.Margin = new Thickness(0, S(b, "type") == "heading" ? 12 : 8, 0, 0);
                host.Children.Add(view);
            }
        }

        FrameworkElement BlockView(IDictionary<string, object> b, Brush fg)
        {
            switch (S(b, "type"))
            {
                case "code":
                    return CodeBlock(S(b, "lang"), S(b, "text"));
                case "heading":
                {
                    int level = I(b, "level");
                    var t = Para(L(b, "inline"), fg, level <= 1 ? 18 : level == 2 ? 16 : 15);
                    t.FontWeight = FontWeights.SemiBold;
                    return t;
                }
                case "list":
                {
                    var col = new StackPanel();
                    bool ordered = B(b, "ordered");
                    int n = 1;
                    foreach (object item in L(b, "items") ?? None)
                    {
                        var g = new Grid();
                        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                        var mark = new TextBlock { Text = ordered ? n.ToString(CultureInfo.InvariantCulture) + "." : "\u2022", Foreground = P.Muted, FontSize = 14, MinWidth = 14, Margin = new Thickness(2, 0, 6, 0) };
                        Put(g, mark, 0, 0);
                        Put(g, Para(item as IList, fg, 14), 1, 0);
                        if (n > 1) g.Margin = new Thickness(0, 3, 0, 0);
                        col.Children.Add(g);
                        n++;
                    }
                    return col;
                }
                case "quote":
                {
                    var t = Para(L(b, "inline"), P.Quote, 14);
                    t.FontStyle = FontStyles.Italic;
                    return new Border { BorderBrush = P.Edge, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(10, 1, 0, 1), Child = t };
                }
                case "rule":
                    return new Border { Height = 1, Background = P.Edge, Margin = new Thickness(0, 4, 0, 4) };
                default:
                    return Para(L(b, "inline"), fg, 14);
            }
        }

        TextBlock Para(IList runs, Brush fg, double size)
        {
            var t = new TextBlock
            {
                Foreground = fg, FontSize = size, TextWrapping = TextWrapping.Wrap, LineHeight = Math.Round(size * 1.45),
                LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            };
            if (runs == null) return t;
            foreach (object o in runs)
            {
                var r = o as IDictionary<string, object>;
                if (r == null) continue;
                string text = S(r, "text");
                if (text.Length == 0) continue;
                var run = new Run(text);
                if (B(r, "code"))
                {
                    run.FontFamily = MonoFont;
                    run.FontSize = size - 1;
                    run.Background = P.InlineBg;
                    run.Foreground = P.InlineText;
                }
                else
                {
                    if (B(r, "bold")) run.FontWeight = FontWeights.SemiBold;
                    if (B(r, "italic")) run.FontStyle = FontStyles.Italic;
                    if (S(r, "link").Length > 0)
                    {
                        run.Foreground = P.Link;
                        run.TextDecorations = TextDecorations.Underline;
                    }
                }
                t.Inlines.Add(run);
            }
            return t;
        }

        FrameworkElement CodeBlock(string lang, string code)
        {
            var head = new DockPanel { Margin = new Thickness(11, 2, 3, 2) };
            var copy = TextButton("\uE8C8", "Копировать", "copy-block", delegate { Copy(code, "code"); }, 11.5);
            DockPanel.SetDock(copy, Dock.Right);
            head.Children.Add(copy);
            var name = OneLine(lang.Length > 0 ? lang : "код", P.Faint, 11.5);
            name.VerticalAlignment = VerticalAlignment.Center;
            head.Children.Add(name);
            // Long lines wrap: nothing in the window scrolls sideways.
            var body = new TextBlock
            {
                Text = code, FontFamily = MonoFont, FontSize = 12.5, Foreground = P.CodeText, TextWrapping = TextWrapping.Wrap,
                Padding = new Thickness(11, 8, 11, 10), LineHeight = 18, LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            };
            body.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ClickCount != 2) return;
                Copy(code, "code");
                e.Handled = true;
            };
            var stack = new StackPanel();
            stack.Children.Add(new Border { BorderBrush = P.Edge, BorderThickness = new Thickness(0, 0, 0, 1), Child = head });
            stack.Children.Add(body);
            return new Border { Background = P.CodeBg, BorderBrush = P.Edge, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Child = stack };
        }

        // ---------------------------------------------------------------- side list of chats

        void ToggleDrawer()
        {
            if (drawerOpen) CloseDrawer();
            else OpenDrawer();
        }

        void OpenDrawer()
        {
            if (drawerOpen) return;
            drawerOpen = true;
            drawer.Visibility = Visibility.Visible;
            scrim.Visibility = Visibility.Visible;
            drawerShift.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(-DrawerWidth, 0, Ms(180)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
            scrim.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, Ms(180)));
        }

        void CloseDrawer()
        {
            if (!drawerOpen) return;
            drawerOpen = false;
            var slide = new DoubleAnimation(0, -DrawerWidth, Ms(140)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
            slide.Completed += delegate
            {
                if (drawerOpen) return;
                drawer.Visibility = Visibility.Collapsed;
                scrim.Visibility = Visibility.Collapsed;
            };
            drawerShift.BeginAnimation(TranslateTransform.XProperty, slide);
            scrim.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, 0, Ms(140)));
        }

        static Duration Ms(int ms)
        {
            return new Duration(TimeSpan.FromMilliseconds(ms));
        }

        void RenderChats()
        {
            chatsPanel.Children.Clear();
            int n = 0;
            foreach (object o in chats)
            {
                var c = o as IDictionary<string, object>;
                if (c == null) continue;
                chatsPanel.Children.Add(ChatRow(c));
                n++;
            }
            chatsCount.Text = n > 0 ? n.ToString(CultureInfo.InvariantCulture) : "";
            if (n == 0) chatsPanel.Children.Add(new TextBlock { Text = "Чатов пока нет.", Foreground = P.Faint, FontSize = 12.5, Margin = new Thickness(16, 8, 16, 8) });
        }

        FrameworkElement ChatRow(IDictionary<string, object> c)
        {
            string id = S(c, "id");
            bool active = B(c, "active");
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var title = OneLine(S(c, "title"), P.Text, 13.5);
            if (active) title.FontWeight = FontWeights.SemiBold;
            Put(g, title, 0, 0);
            string tone = S(c, "tone");
            var when = OneLine(S(c, "when"), tone == "idle" || tone.Length == 0 ? P.Faint : ToneBrush(tone), 11.5);
            when.Margin = new Thickness(10, 1, 0, 0);
            when.VerticalAlignment = VerticalAlignment.Center;
            Put(g, when, 1, 0);
            string preview = S(c, "preview");
            if (preview.Length > 0)
            {
                var p = OneLine(preview, P.Muted, 12);
                p.Margin = new Thickness(0, 2, 0, 0);
                Grid.SetColumnSpan(p, 2);
                Put(g, p, 0, 1);
            }
            Brush normal = active ? P.RowActive : Brushes.Transparent;
            var box = new Border { Background = normal, CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 7, 10, 8), Child = g };
            var b = MakeButton(box, "chat:" + id, S(c, "title"), delegate
            {
                CloseDrawer();
                if (!active) Emit("open", "id", id);
            });
            b.Margin = new Thickness(6, 1, 6, 1);
            if (!active) Hover(b, box, normal, P.RowHover);
            return b;
        }

        // ---------------------------------------------------------------- buttons, clipboard, showing and hiding

        void ToggleTheme()
        {
            string next = themeName == "dark" ? "light" : "dark";
            SetTheme(next);
            Emit("theme", "theme", next);
        }

        void ToggleTall()
        {
            tall = !tall;
            Place();
            tallIcon.Text = tall ? "\uE73F" : "\uE740";
        }

        Row ReplyRow()
        {
            if (selectedId != null)
            {
                int i = IndexOf(selectedId);
                if (i >= 0 && rows[i].Role == "assistant") return rows[i];
            }
            for (int i = rows.Count - 1; i >= 0; i--) if (rows[i].Role == "assistant") return rows[i];
            return null;
        }

        void CopyReply()
        {
            Row r = ReplyRow();
            if (r == null) Flash("Ответа пока нет");
            else Copy(S(r.Data, "text"), "reply");
        }

        void CopyCode()
        {
            string code = null;
            if (selectedId != null)
            {
                int i = IndexOf(selectedId);
                if (i >= 0) code = LastCode(rows[i]);
            }
            for (int i = rows.Count - 1; i >= 0 && code == null; i--) code = LastCode(rows[i]);
            if (code == null) Flash("В этом чате нет кода");
            else Copy(code, "code");
        }

        static string LastCode(Row r)
        {
            if (r.Role != "assistant") return null;
            IList blocks = L(r.Data, "blocks");
            if (blocks == null) return null;
            for (int i = blocks.Count - 1; i >= 0; i--)
            {
                var b = blocks[i] as IDictionary<string, object>;
                if (b != null && S(b, "type") == "code") return S(b, "text");
            }
            return null;
        }

        void Copy(string text, string what)
        {
            if (string.IsNullOrEmpty(text))
            {
                Flash("Нечего копировать");
                return;
            }
            try
            {
                System.Windows.Forms.Clipboard.SetText(text);
            }
            catch (Exception e)
            {
                Flash("Не удалось скопировать");
                Emit("error", "message", "clipboard: " + e.Message);
                return;
            }
            Flash("Скопировано");
            Emit("copied", "what", what);
        }

        void Flash(string text)
        {
            flashBlock.Text = text;
            if (flashTimer == null)
            {
                flashTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1400) };
                flashTimer.Tick += delegate
                {
                    flashTimer.Stop();
                    flashBlock.Text = "";
                };
            }
            flashTimer.Stop();
            flashTimer.Start();
        }

        void OnKey(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape) return;
            if (drawerOpen) CloseDrawer();
            else HideOverlay();
            e.Handled = true;
        }

        void ShowOverlay()
        {
            if (win.IsVisible) return;
            win.Show();
            Emit("visible", "visible", true);
            if (autoScroll) win.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(ScrollToEnd));
        }

        void HideOverlay()
        {
            if (!win.IsVisible) return;
            win.Hide();
            Emit("visible", "visible", false);
        }

        // A short Alt tap with no other key hides the window; two such taps within 450 ms show it.
        void StartKeys()
        {
            var timer = new DispatcherTimer(DispatcherPriority.Input) { Interval = TimeSpan.FromMilliseconds(25) };
            timer.Tick += delegate { PollAlt(); };
            timer.Start();
        }

        void PollAlt()
        {
            int now = Environment.TickCount;
            bool down = (Native.GetAsyncKeyState(0x12) & 0x8000) != 0;
            if (down)
            {
                if (!altDown)
                {
                    altDown = true;
                    altSince = now;
                    altCombo = false;
                }
                if (!altCombo)
                {
                    foreach (int vk in ComboKeys)
                    {
                        if ((Native.GetAsyncKeyState(vk) & 0x8000) == 0) continue;
                        altCombo = true;
                        break;
                    }
                }
                return;
            }
            if (!altDown) return;
            altDown = false;
            bool tap = !altCombo && unchecked(now - altSince) < 350;
            if (!tap) lastTap = 0;
            else if (win.IsVisible)
            {
                lastTap = 0;
                HideOverlay();
            }
            else if (lastTap != 0 && unchecked(now - lastTap) < 450)
            {
                lastTap = 0;
                ShowOverlay();
            }
            else lastTap = now;
        }

        // ---------------------------------------------------------------- helpers

        void Emit(string ev, params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            d["ev"] = ev;
            for (int i = 0; i + 1 < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            string line = json.Serialize(d);
            lock (OutLock)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        static void Put(Grid g, UIElement el, int col, int row)
        {
            Grid.SetColumn(el, col);
            Grid.SetRow(el, row);
            g.Children.Add(el);
        }

        static TextBlock OneLine(string text, Brush fg, double size)
        {
            return new TextBlock { Text = text, Foreground = fg, FontSize = size, TextWrapping = TextWrapping.NoWrap, TextTrimming = TextTrimming.CharacterEllipsis };
        }

        static TextBlock Icon(string glyph, Brush fg, double size)
        {
            return new TextBlock { Text = glyph, FontFamily = IconFont, FontSize = size, Foreground = fg, VerticalAlignment = VerticalAlignment.Center };
        }

        static TextBlock Caption(string text, Brush fg)
        {
            return new TextBlock { Text = text, Foreground = fg, FontSize = 12, FontWeight = FontWeights.SemiBold };
        }

        static string S(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return "";
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        static bool B(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        static int I(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); }
            catch (Exception) { return 0; }
        }

        static IDictionary<string, object> D(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as IDictionary<string, object> : null;
        }

        static IList L(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as IList : null;
        }
    }
}
'@

[PocketOverlay.Overlay]::Run()
`;

/**
 * What goes on disk. Windows PowerShell 5.1 reads a script without a byte order mark in the ANSI code page, which would
 * garble the Russian labels; with the mark it reads UTF-8.
 */
export const OVERLAY_PS_FILE = '\uFEFF' + OVERLAY_PS;
