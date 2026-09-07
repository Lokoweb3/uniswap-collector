// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TreasuryAccount — EIP-6551 Token Bound Account
 * Controls the LOKOVault treasury.
 * Only the NFT holder (owner of LOKOVault #1) can execute transactions.
 */

interface IERC6551Account {
    receive() external payable;
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function owner() external view returns (address);
    function isValidSigner(address signer, bytes calldata context) external view returns (bytes4 magicValue);
}

interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TreasuryAccount is IERC6551Account, IERC6551Executable {

    // ── EIP-6551 State ────────────────────────────────────────────────────────
    uint256 public state;

    // ── Events ────────────────────────────────────────────────────────────────
    event FeeReceived(address indexed token, uint256 amount, address indexed from);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event ETHWithdrawn(uint256 amount, address indexed to);

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner(), "Not NFT holder");
        _;
    }

    // ── Receive ETH ───────────────────────────────────────────────────────────
    receive() external payable override {
        emit FeeReceived(address(0), msg.value, msg.sender);
    }

    // ── EIP-6551 ──────────────────────────────────────────────────────────────
    function token() public view override returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    function owner() public view override returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721Owner(tokenContract).ownerOf(tokenId);
    }

    function isValidSigner(address signer, bytes calldata) external view override returns (bytes4) {
        if (signer == owner()) return IERC6551Account.isValidSigner.selector;
        return bytes4(0);
    }

    // ── Execute (general) ─────────────────────────────────────────────────────
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external payable override onlyOwner returns (bytes memory result) {
        require(operation == 0, "Only CALL");
        state++;
        bool success;
        (success, result) = to.call{value: value}(data);
        require(success, "Call failed");
    }

    // ── Withdraw ERC-20 ───────────────────────────────────────────────────────
    function withdraw(address token_, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Zero address");
        bool ok = IERC20(token_).transfer(to, amount);
        require(ok, "Transfer failed");
        emit Withdrawn(token_, amount, to);
    }

    function withdrawAll(address token_, address to) external onlyOwner {
        require(to != address(0), "Zero address");
        uint256 bal = IERC20(token_).balanceOf(address(this));
        require(bal > 0, "No balance");
        bool ok = IERC20(token_).transfer(to, bal);
        require(ok, "Transfer failed");
        emit Withdrawn(token_, bal, to);
    }

    // ── Withdraw ETH ──────────────────────────────────────────────────────────
    function withdrawETH(uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Zero address");
        require(address(this).balance >= amount, "Insufficient ETH");
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit ETHWithdrawn(amount, to);
    }

    function withdrawAllETH(address to) external onlyOwner {
        require(to != address(0), "Zero address");
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH");
        (bool ok,) = payable(to).call{value: bal}("");
        require(ok, "ETH transfer failed");
        emit ETHWithdrawn(bal, to);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function getBalance(address token_) external view returns (uint256) {
        return IERC20(token_).balanceOf(address(this));
    }

    function getNativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ── ERC-165 ───────────────────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC6551Account).interfaceId ||
               interfaceId == type(IERC6551Executable).interfaceId;
    }
}
