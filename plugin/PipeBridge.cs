using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Microsoft.Win32.SafeHandles;

namespace IfzMcp;

internal sealed class PipeBridge : IDisposable
{
    private const int WorkerCount = 4;
    private readonly BlockingCollection<Call> pending = new(16);
    private readonly CancellationTokenSource stop = new();
    private readonly Action<string> logError;
    private readonly string pipeName;
    private readonly string pipeSddl;

    public PipeBridge(string pipeName, string sid, Action<string> logError)
    {
        this.pipeName = pipeName;
        this.logError = logError;
        if (sid == null || !Regex.IsMatch(sid, @"\AS-1(-\d+)+\z"))
            throw new InvalidOperationException("The installation or test launcher must supply the Windows user SID.");
        pipeSddl = "D:P(A;;GA;;;" + sid + ")";
        using (CreatePipe()) { }
        for (var i = 0; i < WorkerCount; i++)
            _ = Task.Run(Serve);
    }

    public void Pump(Func<string, JObject, object> dispatch)
    {
        for (var i = 0; i < 8 && pending.TryTake(out var call); i++)
        {
            if (Interlocked.CompareExchange(ref call.State, 1, 0) != 0)
                continue;
            try
            {
                var response = JObject.FromObject(dispatch(call.Method, call.Args));
                response["ok"] = true;
                call.Response.TrySetResult(response);
            }
            catch (BridgeException ex)
            {
                call.Response.TrySetResult(Error(ex.Code, ex.Message));
            }
            catch (Exception ex)
            {
                logError(ex.ToString());
                call.Response.TrySetResult(Error("game_error", "See the IFZ plugin log."));
            }
        }
    }

    private void Serve()
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var pipe = CreatePipe();
                using var closeOnStop = stop.Token.Register(pipe.Dispose);
                pipe.WaitForConnection();
                using var timeout = new Timer(_ => pipe.Dispose(), null, 4500, Timeout.Infinite);
                using var reader = new BinaryReader(pipe, Encoding.UTF8, leaveOpen: true);
                var size = reader.ReadInt32();
                if (size < 1 || size > 16384)
                    continue;
                var body = reader.ReadBytes(size);
                if (body.Length != size)
                    continue;

                JObject response;
                try
                {
                    var request = JObject.Parse(Encoding.UTF8.GetString(body));
                    response = Enqueue(new Call((string)request["method"], request["args"] as JObject ?? new JObject()));
                }
                catch (JsonException)
                {
                    response = Error("invalid_request", "Expected a JSON object.");
                }
                var output = Encoding.UTF8.GetBytes(response.ToString(Formatting.None));
                using var writer = new BinaryWriter(pipe, Encoding.UTF8, leaveOpen: true);
                writer.Write(output.Length);
                writer.Write(output);
                writer.Flush();
            }
            catch (IOException)
            {
                // A disconnected client or expired read can be replaced immediately.
            }
            catch (ObjectDisposedException)
            {
                // The deadline or shutdown closed this connection.
            }
            catch (Exception ex)
            {
                if (stop.IsCancellationRequested) return;
                logError("Pipe worker: " + ex);
                if (stop.Token.WaitHandle.WaitOne(1000)) return;
            }
        }
    }

    private JObject Enqueue(Call call)
    {
        if (!pending.TryAdd(call))
            return Error("bridge_busy", "The main-thread queue is full.");
        if (call.Response.Task.Wait(2500, stop.Token))
            return call.Response.Task.Result;
        if (Interlocked.CompareExchange(ref call.State, 2, 0) == 0)
            return Error("unity_timeout", "Unity did not start the request before the deadline.");
        return Error("result_unknown", "Unity started this request. Read state or retry a move with the same request_id.");
    }

    private static JObject Error(string code, string message) =>
        JObject.FromObject(new { ok = false, code, message });

    // Unity Mono exposes CurrentUserOnly but its WindowsIdentity.Owner getter throws.
    private NamedPipeServerStream CreatePipe()
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(pipeSddl, 1, out var descriptor, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var security = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                Descriptor = descriptor
            };
            const uint duplex = 3;
            const uint rejectRemoteClients = 8;
            var handle = CreateNamedPipe(@"\\.\pipe\" + pipeName, duplex, rejectRemoteClients,
                WorkerCount, 16384, 16384, 0, ref security);
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            try
            {
                return new NamedPipeServerStream(PipeDirection.InOut, isAsync: false, isConnected: false, handle);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        public int InheritHandle;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string sddl, uint revision, out IntPtr descriptor, IntPtr size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
        uint maxInstances, uint outBufferSize, uint inBufferSize, uint timeout, ref SecurityAttributes attributes);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public void Dispose() => stop.Cancel();

    private sealed class Call
    {
        public readonly string Method;
        public readonly JObject Args;
        public readonly TaskCompletionSource<JObject> Response = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int State;

        public Call(string method, JObject args)
        {
            Method = method;
            Args = args;
        }
    }
}

internal sealed class BridgeException : Exception
{
    public string Code { get; }

    public BridgeException(string code, string message) : base(message) => Code = code;
}
